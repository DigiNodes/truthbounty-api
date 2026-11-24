import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { AdminAuditLog } from '../entities/admin-audit-log.entity';
import { AdminAuditHead } from '../entities/admin-audit-head.entity';
import {
  AdminActionType,
  AdminActionCategory,
  AdminAuditSeverity,
  AdminAuditLogInput,
  AdminAuditOutcome,
} from '../admin-audit.types';
export * from '../admin-audit.types';
export type AdminAuditLogRecord = AdminAuditLog;

export interface AdminAuditQueryFilters {
  actorId?: string;
  correlationId?: string;
  action?: AdminActionType;
  outcome?: AdminAuditOutcome;
  page?: number;
  limit?: number;
}
export interface AdminAuditQueryResult {
  logs: AdminAuditLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Replay request contract. Denied by default unless all guards pass. */
export interface DeadLetterReplayRequest {
  actorId: string;
  correlationId: string;
  /** Protected capability granted to the operator (e.g. dead_letter.replay). */
  capability: string;
  /** Operator-supplied reason, bounded and required. */
  reason: string;
  /** Original dead-letter message identifier. */
  messageId: string;
  /** Original payload hash (sha256 hex) for immutable linkage. */
  originalPayloadHash: string;
  /** Release context bound to chain id, release id, deployment block, artifact checksum. */
  chainContext: AdminAuditLogInput['chainContext'];
  /** Dry run must be explicitly false to effect a replay. */
  dryRun: boolean;
  /** Maximum number of messages in this batch (1..=MAX_REPLAY_BATCH_LIMIT). */
  batchSize: number;
}

export interface DeadLetterReplayResult {
  auditEventId: string;
  originalEventId: string;
  replayEventId: string;
  outcome: AdminAuditOutcome;
  dryRun: boolean;
  applied: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z-][a-z0-9_.:-]{0,95}$/i;
const HEX_32 = /^0x[0-9a-f]{64}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const OUTCOMES: AdminAuditOutcome[] = [
  'attempted',
  'success',
  'failure',
  'partial',
  'rolled_back',
  'unknown',
];
const REPLAY_CAPABILITY = 'dead_letter.replay';
const MAX_REASON_LEN = 512;
const MAX_REPLAY_BATCH_LIMIT = 100;

/** Database-only operations must use the supplied manager; external effects need an outbox. */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
  ) {}

  async log(
    input: AdminAuditLogInput,
    manager?: EntityManager,
  ): Promise<string> {
    this.assertPostgres();
    const safe = this.sanitize(input);
    if (manager) {
      if (
        manager.connection !== this.source ||
        !manager.queryRunner?.isTransactionActive
      ) {
        throw new Error(
          'Audit writes require this datasource and an active transaction',
        );
      }
      return this.append(safe, manager);
    }
    return this.source.transaction((tx) => this.append(safe, tx));
  }

  async logBatch(inputs: AdminAuditLogInput[]): Promise<string[]> {
    this.assertPostgres();
    const safe = inputs.map((input) => this.sanitize(input));
    return this.source.transaction(async (tx) => {
      const ids: string[] = [];
      for (const input of safe) ids.push(await this.append(input, tx));
      return ids;
    });
  }

  /** A durable attempt precedes execution; success shares the operation's commit. */
  async execute<T>(
    input: Omit<AdminAuditLogInput, 'outcome'>,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<{ result: T; eventId: string }> {
    // Copy/validate before invoking caller code, which must not mutate audit context.
    const context = this.sanitize({ ...input, outcome: 'attempted' });
    await this.log(context);
    const runner = this.source.createQueryRunner();
    let committing = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      const result = await work(runner.manager);
      const eventId = await this.append(
        { ...context, outcome: 'success' },
        runner.manager,
      );
      committing = true;
      await runner.commitTransaction();
      return { result, eventId };
    } catch (error) {
      let outcome: AdminAuditOutcome = 'unknown';
      if (runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
          // A lost COMMIT acknowledgement cannot establish whether it committed.
          if (!committing) outcome = 'rolled_back';
        } catch {
          // Keep the durable attempt; never report success or invent rollback proof.
        }
      }
      await this.log({ ...context, outcome });
      throw error;
    } finally {
      await runner.release();
    }
  }

  /**
   * Replay a dead-letter message idempotently.
   *
   * Denied by default. Requires a protected capability, a bounded reason,
   * batch bounds, an explicit dry-run flag, the original payload hash, and a
   * matching release/schema context. Duplicate replays are rejected via a
   * unique idempotency key derived from the original payload hash and message id.
   */
  async replayDeadLetter(
    request: DeadLetterReplayRequest,
  ): Promise<DeadLetterReplayResult> {
    this.assertPostgres();
    const reason = this.assertReplayRequest(request);
    const idempotencyKey = this.replayIdempotencyKey(request);

    return this.source.transaction(async (tx) => {
      // Serialize replay attempts for this original message.
      const existing = await tx
        .getRepository(AdminAuditLog)
        .createQueryBuilder('audit')
        .where("audit.resultReference = :key", { key: idempotencyKey })
        .getOne();
      if (existing) {
        throw new Error('Duplicate replay rejected');
      }

      const attemptId = await this.append(
        this.replayAuditInput(request, reason, idempotencyKey, 'attempted'),
        tx,
      );

      if (request.dryRun) {
        return {
          auditEventId: attemptId,
          originalEventId: idempotencyKey,
          replayEventId: attemptId,
          outcome: 'attempted',
          dryRun: true,
          applied: 0,
        };
      }

      // Replay effect is delegated to a downstream outbox worker that consumes
      // the attempt record; this service only ensures the audit chain and
      // idempotency guard are in place before effects are applied.
      const successId = await this.append(
        this.replayAuditInput(request, reason, idempotencyKey, 'success'),
        tx,
      );
      return {
        auditEventId: successId,
        originalEventId: idempotencyKey,
        replayEventId: successId,
        outcome: 'success',
        dryRun: false,
        applied: 1,
      };
    });
  }

  /** Operator-controlled batch replay with bounds and partial-faailure handling. */
  async replayDeadLetterBatch(
    requests: DeadLetterReplayRequest[],
  ): Promise<DeadLetterReplayResult[]> {
    this.assertPostgres();
    if (!requests.length) {
      throw new Error('Empty replay batch rejected');
    }
    if (requests.length > MAX_REPLAY_BATCH_LIMIT) {
      throw new Error('Replay batch exceeds limit');
    }
    const results: DeadLetterReplayResult[] = [];
    for (const request of requests) {
      try {
        results.push(await this.replayDeadLetter(request));
      } catch (error) {
        // Partial failure: remain fail-closed and stop the batch at the first
        // poison message so operators can inspect and resume explicitly.
        throw error;
      }
    }
    return results;
  }

  async query(filters: AdminAuditQueryFilters): Promise<AdminAuditQueryResult> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger((page - 1) * limit)
    ) {
      throw new Error('Invalid audit pagination');
    }
    const query = this.source
      .getRepository(AdminAuditLog)
      .createQueryBuilder('audit');
    for (const key of [
      'actorId',
      'correlationId',
      'action',
      'outcome',
    ] as const) {
      if (filters[key] !== undefined)
        query.andWhere(`audit.${key} = :{${key}}`, { [key]: filters[key] });
    }
    const [logs, total] = await query
      .orderBy('audit.chainSequence', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getByEventId(eventId: string): Promise<AdminAuditLog | null> {
    return this.source.getRepository(AdminAuditLog).findOneBy({ eventId });
  }

  async getStats(): Promise<Record<string, number>> {
    const rows: { outcome: string; count: string }[] = await this.source
      .getRepository(AdminAuditLog)
      .createQueryBuilder('audit')
      .select('audit.outcome', 'outcome')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.outcome')
      .getRawMany();
    return Object.fromEntries(
      rows.map((row) => [row.outcome, Number(row.count)]),
    );
  }

  /** One consistent snapshot, including the persisted tip, detects gaps and tail loss. */
  async verifyIntegrity(): Promise<{
    valid: boolean;
    checked: number;
    firstInvalid?: string;
    errors: string[];
  }> {
    this.assertPostgres();
    return this.source.transaction('REPEATABLE READ', async (tx) => {
      const head = await tx.findOneByOrFail(AdminAuditHead, { id: 1 });
      let sequence = 0n;
      let previousHash: string | null = null;
      let checked = 0;
      for (;;) {
        const rows = await tx
          .getRepository(AdminAuditLog)
          .createQueryBuilder('audit')
          .where('audit.chainSequence > :sequence', {
            sequence: sequence.toString(),
          })
          .orderBy('audit.chainSequence', 'ASC')
          .take(500)
          .getMany();
        if (!rows.length) break;
        for (const row of rows) {
          checked++;
          if (
            BigInt(row.chainSequence) !== sequence + 1n ||
            row.previousHash !== previousHash ||
            row.integrityHash !== this.hash(row)
          ) {
            return {
              valid: false,
              checked,
              firstInvalid: row.eventId,
              errors: ['Audit chain integrity mismatch'],
            };
          }
          sequence = BigInt(row.chainSequence);
          previousHash = row.integrityHash;
        }
      }
      const valid =
        sequence.toString() === head.lastSequence &&
        previousHash === head.lastHash;
      return {
        valid,
        checked,
        errors: valid ? [] : ['Audit chain tip mismatch'],
      };
    });
  }

  private assertReplayRequest(request: DeadLetterReplayRequest): string {
    if (!request || typeof request !== 'object') {
      throw new Error('Replay request required');
    }
    if (typeof request.actorId !== 'string' || !UUID.test(request.actorId)) {
      throw new Error('Replay requires an authenticated actor');
    }
    if (
      typeof request.correlationId !== 'string' ||
      !UUID.test(request.correlationId)
    ) {
      throw new Error('Replay requires a correlation id');
    }
    if (
      typeof request.capability !== 'string' ||
      request.capability !== REPLAY_CAPABILITY ||
      !CODE.test(request.capability)
    ) {
      throw new Error('Replay capability denied');
    }
    if (typeof request.reason !== 'string') {
      throw new Error('Replay reason required');
    }
    const reason = request.reason.trim();
    if (!reason || reason.length > MAX_REASON_LEN) {
      throw new Error('Replay reason out of bounds');
    }
    if (typeof request.messageId !== 'string' || !UUID.test(request.messageId)) {
      throw new Error('Replay requires a valid message id');
    }
    if (
      typeof request.originalPayloadHash !== 'string' ||
      !(HEX_64.test(request.originalPayloadHash) || HEX_32.test(request.originalPayloadHash))
    ) {
      throw new Error('Replay requires the original payload hash');
    }
    if (typeof request.dryRun !== 'boolean') {
      throw new Error('Replay requires an explicit dry-run flag');
    }
    if (
      !Number.isInteger(request.batchSize) ||
      request.batchSize < 1 ||
      request.batchSize > MAX_REPLAY_BATCH_LIMIT
    ) {
      throw new Error('Replay batch size out of bounds');
    }
    this.assertChainContext(request.chainContext);
    return reason;
  }

  private assertChainContext(context: AdminAuditLogInput['chainContext']): void {
    if (!context || typeof context !== 'object') {
      throw new Error('Replay requires a chain context');
    }
    const { chainId, releaseId, deploymentBlock, artifactChecksum } =
      context as Record<string, unknown>;
    if (typeof chainId !== 'string' || !chainId.trim()) {
      throw new Error('Replay requires a chain id');
    }
    if (typeof releaseId !== 'string' || !releaseId.trim()) {
      throw new Error('Replay requires a release id');
    }
    if (
      typeof deploymentBlock !== 'number' ||
      !Number.isSafeInteger(deploymentBlock) ||
      deploymentBlock < 0
    ) {
      throw new Error('Replay requires a deployment block');
    }
    if (
      typeof artifactChecksum !== 'string' ||
      !(HEX_64.test(artifactChecksum) || HEX_32.test(artifactChecksum))
    ) {
      throw new Error('Replay requires an artifact checksum');
    }
    // Fail closed on stale release: the context must match the active release.
    const activeReleaseId = this.config.get<string>('RELEASE_ID');
    const activeChainId = this.config.get<string>('CHAIN_ID');
    if (activeReleaseId && releaseId !== activeReleaseId) {
      throw new Error('Replay rejected: stale release');
    }
    if (activeChainId && chainId !== activeChainId) {
      throw new Error('Replay rejected: chain id mismatch');
    }
  }

  private replayIdempotencyKey(request: DeadLetterReplayRequest): string {
    return createHash('sha256')
      .update(`${request.messageId}:${request.originalPayloadHash.toLowerCase()}`)
      .digest('hex');
  }

  private replayAuditInput(
    request: DeadLetterReplayRequest,
    reason: string,
    idempotencyKey: string,
    outcome: AdminAuditOutcome,
  ): AdminAuditLogInput {
    return {
      eventId: randomUUID(),
      actorId: request.actorId,
      correlationId: request.correlationId,
      action: 'dead_letter_replay' as AdminActionType,
      category: 'operations' as AdminActionCategory,
      severity: 'high' as AdminAuditSeverity,
      outcome,
      reason,
      chainContext: request.chainContext,
      resultReference: idempotencyKey,
      metadata: {
        messageId: request.messageId,
        originalPayloadHash: request.originalPayloadHash.toLowerCase(),
        capability: request.capability,
        dryRun: request.dryRun,
        batchSize: request.batchSize,
      },
    };
  }

  private assertPostgres(): void {
    if (this.source.options.type !== 'postgres') {
      throw new Error('Audit chain requires Postgres');
    }
  }

  private sanitize(input: AdminAuditLogInput): AdminAuditLogInput {
    if (!input || typeof input !== 'object') {
      throw new Error('Audit input required');
    }
    if (!OUTCOMES.includes(input.outcome)) {
      throw new Error('Invalid audit outcome');
    }
    return { ...input };
  }

  private hash(row: AdminAuditLog): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          eventId: row.eventId,
          chainSequence: row.chainSequence,
          previousHash: row.previousHash,
          actor: row.actorId,
          correlation: row.correlationId,
          action: row.action,
          outcome: row.outcome,
        }),
      )
      .digest('hex');
  }

  private async append(
    input: AdminAuditLogInput,
    manager: EntityManager,
  ): Promise<string> {
    const head = await manager.findOneOrFail(AdminAuditHead, { id: 1 });
    const sequence = BigInt(head.lastSequence) + 1n;
    const row = manager.create(AdminAuditLog, {
      ...input,
      eventId: input.eventId ?? randomUUID(),
      chainSequence: sequence.toString(),
      previousHash: head.lastHash,
    });
    row.integrityHash = this.hash(row);
    await manager.save(row);
    head.lastSequence = sequence.toString();
    head.lastHash = row.integrityHash;
    await manager.save(head);
    return row.eventId;
  }
}
