import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import {
  AbuseAppeal,
  AbuseAppealError,
  AbuseAppealRegister,
  AbuseAppealStatus,
} from './abuse-appeal.service';
import {
  AbuseDecisionFilter,
  AbuseSignalStore,
  InMemoryAbuseSignalStore,
} from './abuse-signal.store';
import {
  AbuseAction,
  AbuseActionStatus,
  AbuseDecision,
  AbuseDecisionOutcome,
  AbuseIndeterminateReason,
  AbuseReasonCode,
  AbuseSignalKind,
  AbuseSubjectKind,
} from './abuse-signals.types';
import { PublicErrorCode } from '../common/constants/error-codes';
import { AbuseActionRecord } from './entities/abuse-action-record.entity';
import { AbuseAppealDecisionHistoryRecord } from './entities/abuse-appeal-decision-history.entity';
import { AbuseAppealRecord } from './entities/abuse-appeal-record.entity';
import { AbuseDecisionRecord } from './entities/abuse-decision-record.entity';

function appealFromRecord(record: AbuseAppealRecord): AbuseAppeal {
  return {
    id: record.id,
    actionId: record.actionId,
    subjectKey: record.subjectKey,
    reason: record.reason,
    status: record.status as AbuseAppealStatus,
    submittedAt: record.submittedAt.toISOString(),
    reviewDueAt: record.reviewDueAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decidedBy: record.decidedBy,
    decisionNote: record.decisionNote,
  };
}

function appealToRecord(appeal: AbuseAppeal): Partial<AbuseAppealRecord> {
  return {
    id: appeal.id,
    actionId: appeal.actionId,
    subjectKey: appeal.subjectKey,
    reason: appeal.reason,
    status: appeal.status,
    submittedAt: new Date(appeal.submittedAt),
    reviewDueAt: new Date(appeal.reviewDueAt),
    decidedAt: appeal.decidedAt ? new Date(appeal.decidedAt) : null,
    decidedBy: appeal.decidedBy,
    decisionNote: appeal.decisionNote,
  };
}

/** PostgreSQL-backed appeal register with atomic duplicate/queue checks. */
export class TypeOrmAbuseAppealRegister implements AbuseAppealRegister {
  constructor(
    @InjectRepository(AbuseAppealRecord)
    private readonly appealRepository: Repository<AbuseAppealRecord>,
  ) {}

  async put(appeal: AbuseAppeal): Promise<void> {
    await this.appealRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(AbuseAppealRecord);
      const existing = await repository.findOne({ where: { id: appeal.id } });

      if (!existing) {
        await repository.insert(appealToRecord(appeal));
        if (appeal.status !== AbuseAppealStatus.PENDING) {
          await this.insertHistory(manager, appeal);
        }
        return;
      }

      if (
        (existing.status as AbuseAppealStatus) !== AbuseAppealStatus.PENDING
      ) {
        return;
      }

      const result = await repository.update(
        { id: appeal.id, status: AbuseAppealStatus.PENDING },
        appealToRecord(appeal),
      );
      if (!result.affected) return;
      if (appeal.status !== AbuseAppealStatus.PENDING) {
        await this.insertHistory(manager, appeal);
      }
    });
  }

  async putPending(appeal: AbuseAppeal, maxOpenAppeals: number): Promise<void> {
    await this.appealRepository.manager.transaction(async (manager) => {
      // Serialize submissions for one subject so the max-open rule is an
      // invariant under concurrent requests, not a best-effort precheck.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        appeal.subjectKey,
      ]);

      const repository = manager.getRepository(AbuseAppealRecord);
      const duplicate = await repository.findOne({
        where: {
          actionId: appeal.actionId,
          status: AbuseAppealStatus.PENDING,
        },
      });
      if (duplicate) {
        throw new AbuseAppealError(
          409,
          PublicErrorCode.CONFLICT,
          'An appeal for this action is already under review.',
        );
      }

      const open = await repository.count({
        where: {
          subjectKey: appeal.subjectKey,
          status: AbuseAppealStatus.PENDING,
        },
      });
      if (open >= maxOpenAppeals) {
        throw new AbuseAppealError(
          429,
          PublicErrorCode.RATE_LIMITED,
          'Too many open appeals. Please wait for a decision.',
        );
      }
      await repository.insert(appealToRecord(appeal));
    });
  }

  async get(id: string): Promise<AbuseAppeal | null> {
    const record = await this.appealRepository.findOne({ where: { id } });
    return record ? appealFromRecord(record) : null;
  }

  async list(
    filter: {
      subjectKey?: string;
      status?: AbuseAppealStatus;
    } = {},
  ): Promise<AbuseAppeal[]> {
    const records = await this.appealRepository.find({
      where: {
        ...(filter.subjectKey ? { subjectKey: filter.subjectKey } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      order: { submittedAt: 'DESC' },
    });
    return records.map(appealFromRecord);
  }

  countOpen(subjectKey: string): Promise<number> {
    return this.appealRepository.count({
      where: { subjectKey, status: AbuseAppealStatus.PENDING },
    });
  }

  private async insertHistory(
    manager: EntityManager,
    appeal: AbuseAppeal,
  ): Promise<void> {
    await manager.getRepository(AbuseAppealDecisionHistoryRecord).insert({
      id: randomUUID(),
      appealId: appeal.id,
      status: appeal.status,
      decidedAt: new Date(appeal.decidedAt ?? appeal.submittedAt),
      decidedBy: appeal.decidedBy ?? 'system:expiry',
      decisionNote: appeal.decisionNote,
    });
  }
}

function actionFromRecord(record: AbuseActionRecord): AbuseAction {
  return {
    id: record.id,
    subjectKey: record.subjectKey,
    subjectKind: record.subjectKind as AbuseSubjectKind,
    kind: record.kind as AbuseAction['kind'],
    status: record.status as AbuseActionStatus,
    reasonCode: record.reasonCode as AbuseReasonCode,
    reasonCodeVersion: record.reasonCodeVersion,
    modelVersion: record.modelVersion,
    configVersion: record.configVersion,
    binding: {
      chainId: record.bindingChainId,
      releaseId: record.releaseId,
      deploymentBlock: BigInt(record.deploymentBlock),
      artifactChecksum: record.artifactChecksum,
    },
    costMultiplier: record.costMultiplier,
    startedAt: record.startedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    appealable: true,
    escalationLevel: record.escalationLevel,
  };
}

function actionToRecord(action: AbuseAction): Partial<AbuseActionRecord> {
  return {
    id: action.id,
    subjectKey: action.subjectKey,
    subjectKind: action.subjectKind,
    kind: action.kind,
    status: action.status,
    reasonCode: action.reasonCode,
    reasonCodeVersion: action.reasonCodeVersion,
    modelVersion: action.modelVersion,
    configVersion: action.configVersion,
    bindingChainId: action.binding.chainId,
    releaseId: action.binding.releaseId,
    deploymentBlock: action.binding.deploymentBlock.toString(),
    artifactChecksum: action.binding.artifactChecksum,
    costMultiplier: action.costMultiplier,
    startedAt: new Date(action.startedAt),
    expiresAt: new Date(action.expiresAt),
    appealable: action.appealable,
    escalationLevel: action.escalationLevel,
  };
}

function decisionFromRecord(
  record: AbuseDecisionRecord,
  action: AbuseAction | null,
): AbuseDecision {
  return {
    id: record.id,
    subjectKey: record.subjectKey,
    subjectKind: record.subjectKind as AbuseSubjectKind,
    outcome: record.outcome as AbuseDecisionOutcome,
    indeterminateReason:
      record.indeterminateReason as AbuseIndeterminateReason | null,
    reasonCode: record.reasonCode as AbuseReasonCode | null,
    reasonCodeVersion: record.reasonCodeVersion,
    kind: record.signalKind as AbuseSignalKind | null,
    severity: record.severity as AbuseDecision['severity'],
    confidence: record.confidence,
    sampleCount: record.sampleCount,
    corroboratingDimensions: record.corroboratingDimensions,
    modelVersion: record.modelVersion,
    configVersion: record.configVersion,
    binding:
      record.bindingChainId == null
        ? null
        : {
            chainId: record.bindingChainId,
            releaseId: record.releaseId!,
            deploymentBlock: BigInt(record.deploymentBlock!),
            artifactChecksum: record.artifactChecksum!,
          },
    action,
    decidedAt: record.decidedAt.toISOString(),
  };
}

/**
 * Durable decisions/actions backed by TypeORM. Window aggregates remain in the
 * existing bounded store because they are evaluation cache, not moderation
 * history; decisions, actions and appeals survive process restarts.
 */
export class TypeOrmAbuseSignalStore implements AbuseSignalStore {
  private readonly windows = new InMemoryAbuseSignalStore();

  constructor(
    @InjectRepository(AbuseDecisionRecord)
    private readonly decisionRepository: Repository<AbuseDecisionRecord>,
    @InjectRepository(AbuseActionRecord)
    private readonly actionRepository: Repository<AbuseActionRecord>,
  ) {}

  record(...args: Parameters<InMemoryAbuseSignalStore['record']>) {
    return this.windows.record(...args);
  }

  windowFor(...args: Parameters<InMemoryAbuseSignalStore['windowFor']>) {
    return this.windows.windowFor(...args);
  }

  distinctSubjectsForCredential(
    ...args: Parameters<
      InMemoryAbuseSignalStore['distinctSubjectsForCredential']
    >
  ) {
    return this.windows.distinctSubjectsForCredential(...args);
  }

  async recordDecision(decision: AbuseDecision): Promise<void> {
    const existing = await this.decisionRepository.findOne({
      where: { id: decision.id },
    });
    if (existing) return;
    await this.decisionRepository.insert({
      id: decision.id,
      subjectKey: decision.subjectKey,
      subjectKind: decision.subjectKind,
      outcome: decision.outcome,
      indeterminateReason: decision.indeterminateReason,
      reasonCode: decision.reasonCode,
      reasonCodeVersion: decision.reasonCodeVersion,
      signalKind: decision.kind,
      severity: decision.severity,
      confidence: decision.confidence,
      sampleCount: decision.sampleCount,
      corroboratingDimensions: decision.corroboratingDimensions,
      modelVersion: decision.modelVersion,
      configVersion: decision.configVersion,
      bindingChainId: decision.binding?.chainId ?? null,
      releaseId: decision.binding?.releaseId ?? null,
      deploymentBlock: decision.binding?.deploymentBlock.toString() ?? null,
      artifactChecksum: decision.binding?.artifactChecksum ?? null,
      actionId: decision.action?.id ?? null,
      actionKind: decision.action?.kind ?? null,
      actionStatus: decision.action?.status ?? null,
      actionExpiresAt: decision.action
        ? new Date(decision.action.expiresAt)
        : null,
      escalationLevel: decision.action?.escalationLevel ?? 0,
      appealable: true,
      decidedAt: new Date(decision.decidedAt),
    });
  }

  async getDecision(id: string): Promise<AbuseDecision | null> {
    const record = await this.decisionRepository.findOne({ where: { id } });
    if (!record) return null;
    const action = record.actionId
      ? await this.getAction(record.actionId)
      : null;
    return decisionFromRecord(record, action);
  }

  async listDecisions(
    filter: AbuseDecisionFilter = {},
  ): Promise<AbuseDecision[]> {
    const records = await this.decisionRepository.find({
      where: {
        ...(filter.subjectKey ? { subjectKey: filter.subjectKey } : {}),
        ...(filter.outcome ? { outcome: filter.outcome } : {}),
      },
      order: { decidedAt: 'DESC' },
      take: Math.min(Math.max(filter.limit ?? 100, 1), 500),
    });
    return Promise.all(
      records.map(async (record) =>
        decisionFromRecord(
          record,
          record.actionId ? await this.getAction(record.actionId) : null,
        ),
      ),
    );
  }

  async activeAction(
    subjectKey: string,
    now: number,
  ): Promise<AbuseAction | null> {
    const record = await this.actionRepository
      .createQueryBuilder('action')
      .where('action.subjectKey = :subjectKey', { subjectKey })
      .andWhere('action.status = :status', { status: AbuseActionStatus.ACTIVE })
      .andWhere('action.expiresAt > :now', { now: new Date(now) })
      .orderBy('action.startedAt', 'DESC')
      .getOne();
    return record ? actionFromRecord(record) : null;
  }

  async putAction(action: AbuseAction): Promise<void> {
    const existing = await this.actionRepository.findOne({
      where: { id: action.id },
    });
    if (!existing) {
      await this.actionRepository.insert(actionToRecord(action));
      return;
    }
    if (
      existing.subjectKey !== action.subjectKey ||
      existing.startedAt.getTime() !== new Date(action.startedAt).getTime() ||
      existing.expiresAt.getTime() !== new Date(action.expiresAt).getTime()
    ) {
      throw new Error(`ABUSE_ACTION_ID_CONFLICT: ${action.id}`);
    }
    if ((existing.status as AbuseActionStatus) !== action.status) {
      await this.actionRepository.update(
        { id: action.id },
        { status: action.status },
      );
    }
  }

  async getAction(actionId: string): Promise<AbuseAction | null> {
    const record = await this.actionRepository.findOne({
      where: { id: actionId },
    });
    return record ? actionFromRecord(record) : null;
  }

  async actionsFor(subjectKey: string): Promise<AbuseAction[]> {
    const records = await this.actionRepository.find({
      where: { subjectKey },
      order: { startedAt: 'DESC' },
    });
    return records.map(actionFromRecord);
  }

  async actionsStartedBefore(
    subjectKey: string,
    beforeMs: number,
  ): Promise<number> {
    return this.actionRepository
      .createQueryBuilder('action')
      .where('action.subjectKey = :subjectKey', { subjectKey })
      .andWhere('action.startedAt < :before', { before: new Date(beforeMs) })
      .getCount();
  }
}
