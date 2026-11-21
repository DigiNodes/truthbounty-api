import {
  BadRequestException, ConflictException, Injectable,
  NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  AdminActionCategory, AdminActionType, AdminAuditLogInput, AdminAuditSeverity,
} from '../../audit/admin-audit.types';
import { AdminAuditService } from '../../audit/services/admin-audit.service';
import {
  readBudgetChangeReference, readBudgetOverrideId, readBudgetOverrideInput,
  readBudgetPolicyInput, readBudgetPriceInput,
} from './ai-budget.dto';
import { assertAiBudgetOperator } from './ai-budget-operator.guard';
import { getBudgetWindow, validateBudgetPolicy } from './ai-budget-policy';
import { AiBudgetService } from './ai-budget.service';
import {
  AiBudgetActor, AiBudgetAuthority, AiBudgetOverrideInput,
  AiBudgetPolicyInput, AiBudgetPriceInput, AiBudgetRule,
} from './ai-budget.types';

type Operation = 'price.create' | 'policy.activate' | 'coverage.begin' |
  'override.create' | 'override.revoke';
const OPERATIONS = Object.freeze({
  'price.create': Object.freeze({ action: AdminActionType.CONFIG_CREATE, target: 'ai_budget_price' }),
  'policy.activate': Object.freeze({ action: AdminActionType.CONFIG_UPDATE, target: 'ai_budget_policy' }),
  'coverage.begin': Object.freeze({ action: AdminActionType.CONFIG_UPDATE, target: 'ai_budget_coverage' }),
  'override.create': Object.freeze({ action: AdminActionType.RATE_LIMIT_OVERRIDE, target: 'ai_budget_override' }),
  'override.revoke': Object.freeze({ action: AdminActionType.RATE_LIMIT_OVERRIDE, target: 'ai_budget_override' }),
});
const MAX_OVERRIDE_LIFETIME_MS = 24 * 60 * 60 * 1000;
type ChangeReference = { readonly changeReference: string };

/** Bounded administration on the same durable authority used for admission. */
@Injectable()
export class AiBudgetAdminService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
    private readonly budget: AiBudgetService,
  ) {}

  async createPrice(actor: AiBudgetActor, input: AiBudgetPriceInput) {
    const operator = assertAiBudgetOperator(actor, this.config);
    const value = readBudgetPriceInput(input);
    const id = randomUUID();
    return this.execute(operator, 'price.create', id, value.changeReference,
      async (manager, now) => {
        await manager.query(
          'INSERT INTO ai_budget_prices ' +
          '(id, provider, model, input_nanos, output_nanos, cached_input_nanos, created_at, actor_id, change_reference) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [id, value.provider, value.model, value.inputNanos, value.outputNanos,
            value.cachedInputNanos, now, operator.id, value.changeReference],
        );
        return { id };
      });
  }

  async activatePolicy(actor: AiBudgetActor, input: AiBudgetPolicyInput) {
    const operator = assertAiBudgetOperator(actor, this.config);
    const value = readBudgetPolicyInput(input);
    const id = randomUUID();
    return this.execute(operator, 'policy.activate', id, value.changeReference,
      async (manager, now) => {
        await manager.query(
          'INSERT INTO ai_budget_policies (id, rules, created_at, actor_id, change_reference) ' +
          'VALUES ($1, $2::jsonb, $3, $4, $5)',
          [id, JSON.stringify(value.rules), now, operator.id, value.changeReference],
        );
        // Version activation never resets accumulated usage, coverage or a provider-bound halt.
        await manager.query('UPDATE ai_budget_authority SET policy_version = $1 WHERE id = 1', [id]);
        return { id };
      });
  }

  async beginCoverage(actor: AiBudgetActor, input: ChangeReference) {
    const operator = assertAiBudgetOperator(actor, this.config);
    const changeReference = readBudgetChangeReference(input);
    const id = randomUUID();
    return this.execute(operator, 'coverage.begin', id, changeReference,
      async (manager, now, authority) => {
        if (authority.coverageStart !== null) {
          throw new ConflictException('AI budget coverage is already initialized');
        }
        await this.selectedPolicy(manager, authority);
        // Operators quiesce legacy paid traffic before this checkpoint; admission enforces window drain.
        await manager.query(
          'UPDATE ai_budget_authority SET coverage_start = $1 WHERE id = 1 AND coverage_start IS NULL',
          [now],
        );
        return { coverageStart: now.toISOString() };
      });
  }

  async createOverride(actor: AiBudgetActor, input: AiBudgetOverrideInput) {
    const operator = assertAiBudgetOperator(actor, this.config);
    const value = readBudgetOverrideInput(input);
    const id = randomUUID();
    return this.execute(operator, 'override.create', id, value.changeReference,
      async (manager, now, authority) => {
        const { start, end } = getBudgetWindow(value.window, now);
        const expiresAt = new Date(value.expiresAt);
        if (expiresAt.getTime() <= now.getTime() ||
            expiresAt.getTime() > Math.min(end.getTime(), now.getTime() + MAX_OVERRIDE_LIFETIME_MS)) {
          throw new BadRequestException('AI budget override expiry is outside the allowed window');
        }
        if (!authority.coverageStart || start.getTime() < authority.coverageStart.getTime()) {
          throw new ServiceUnavailableException('AI budget coverage is not ready');
        }
        const rules = await this.selectedPolicy(manager, authority);
        if (!rules.some((rule) => rule.scope === 'user' && rule.window === value.window &&
            (rule.subject === '*' || rule.subject === value.userId))) {
          throw new BadRequestException('No applicable user budget for this override window');
        }
        await this.insertOverride(manager, now, start, expiresAt, id, operator, value);
        return { id, expiresAt: expiresAt.toISOString() };
      });
  }

  async revokeOverride(actor: AiBudgetActor, overrideId: string, input: ChangeReference) {
    const operator = assertAiBudgetOperator(actor, this.config);
    const id = readBudgetOverrideId(overrideId);
    const changeReference = readBudgetChangeReference(input);
    return this.execute(operator, 'override.revoke', id, changeReference,
      async (manager, now) => {
        const rows: { id: string; revoked_at: Date | null }[] = await manager.query(
          'SELECT id, revoked_at FROM ai_budget_overrides WHERE id = $1',
          [id],
        );
        if (rows.length !== 1) throw new NotFoundException('AI budget override not found');
        const revokedAt = rows[0].revoked_at ? new Date(rows[0].revoked_at) : now;
        if (!rows[0].revoked_at) {
          // Revocation affects new admission only; original attempts and their charges stay intact.
          await manager.query(
            'UPDATE ai_budget_overrides SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
            [id, now],
          );
        }
        return { id, revokedAt: revokedAt.toISOString() };
      });
  }

  private async insertOverride(
    manager: EntityManager, now: Date, start: Date, expiresAt: Date,
    id: string, operator: AiBudgetActor, value: AiBudgetOverrideInput,
  ): Promise<void> {
    const active: { id: string }[] = await manager.query(
      'SELECT id FROM ai_budget_overrides WHERE user_id = $1 AND "window" = $2 ' +
      'AND window_start = $3 AND revoked_at IS NULL AND expires_at > $4',
      [value.userId, value.window, start, now],
    );
    if (active.length) throw new ConflictException('An active user budget override already exists');
    // No scope/bypass columns exist: admission applies these bonuses only to user rules.
    await manager.query(
      'INSERT INTO ai_budget_overrides ' +
      '(id, user_id, "window", window_start, extra_tokens, extra_nanos, expires_at, created_at, actor_id, change_reference) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, value.userId, value.window, start, value.extraTokens, value.extraSpendUsdNanos,
        expiresAt, now, operator.id, value.changeReference],
    );
  }

  private async selectedPolicy(
    manager: EntityManager, authority: AiBudgetAuthority,
  ): Promise<readonly AiBudgetRule[]> {
    if (!authority.policyVersion) throw new ServiceUnavailableException('AI budget policy is unavailable');
    const rows: { rules: readonly AiBudgetRule[] }[] = await manager.query(
      'SELECT rules FROM ai_budget_policies WHERE id = $1', [authority.policyVersion],
    );
    if (rows.length !== 1) throw new ServiceUnavailableException('AI budget policy is unavailable');
    try {
      return validateBudgetPolicy(rows[0].rules);
    } catch {
      throw new ServiceUnavailableException('AI budget policy is unavailable');
    }
  }

  private async execute<T extends object>(
    actor: AiBudgetActor, operation: Operation, id: string, changeReference: string,
    work: (manager: EntityManager, now: Date, authority: AiBudgetAuthority) => Promise<T>,
  ): Promise<T & { readonly auditEventId: string }> {
    const definition = OPERATIONS[operation];
    const requestId = randomUUID();
    const context: Omit<AdminAuditLogInput, 'outcome'> = {
      actorId: actor.id, actorType: 'user', action: definition.action,
      actionCategory: operation.startsWith('override.') ? AdminActionCategory.SECURITY : AdminActionCategory.CONFIGURATION,
      targetType: definition.target, targetId: id,
      capability: 'ai_budget.' + operation + ':' + changeReference,
      authoritySource: 'rbac', authorityReference: actor.id,
      requestReference: requestId, correlationId: requestId,
      resultReference: id, severity: AdminAuditSeverity.HIGH,
    };
    const executed = await this.audit.execute(context, async (manager) => {
      if (this.source.options.type !== 'postgres' || manager.connection !== this.source ||
          !manager.queryRunner?.isTransactionActive) {
        throw new ServiceUnavailableException('AI budget administration is unavailable');
      }
      // execute appends success on this exact manager before commit releases the authority lock.
      return this.budget.withAuthority(manager, (now, authority) => {
        assertAiBudgetOperator(actor, this.config);
        return work(manager, now, authority);
      });
    });
    return Object.freeze({ ...executed.result, auditEventId: executed.eventId });
  }
}
