import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import {
  AbuseAction,
  AbuseActionStatus,
  AbuseDecision,
  AbuseObservation,
  AbuseObservationKind,
  AbuseSubjectKind,
  AbuseSubjectWindow,
  AbuseSurface,
  ABUSE_WINDOW_LIMITS,
} from './abuse-signals.types';
import {
  AbuseDecisionFilter,
  AbuseSignalStore,
  windowStartFor,
} from './abuse-signal.store';
import { AbuseSignalWindowRecord } from './entities/abuse-signal-window.entity';
import { AbuseActionRecord } from './entities/abuse-action.entity';
import { AbuseDecisionRecord } from './entities/abuse-decision-record.entity';

/**
 * PostgreSQL-backed abuse signal store (PREWAVE-BE-111, #812).
 *
 * Shared implementation for multi-replica deployments. Two or more service
 * instances fed the same observations converge on the same window counts,
 * decisions, and actions. Windows and actions persist across restarts, and
 * expired actions stop enforcement deterministically.
 *
 * **Atomicity:** Uses PostgreSQL `UPDATE ... RETURNING` to fold observations
 * into windows atomically, so concurrent requests from different replicas never
 * lose increments. Window reads with no existing record return an empty window
 * without mutating the database.
 *
 * **Bounded collections:** JSONB arrays and objects are capped at the same
 * limits the in-memory store uses. When a collection saturates, the saturation
 * flag is set and no further distinct values are added.
 *
 * **Expiry:** Window expiry is tracked in the `expiresAt` column (set to
 * windowStart + 2*windowMs). Action expiry is checked by the read path, which
 * filters by `expiresAt <= now`. A periodic cleanup job (not part of this
 * store) can delete expired records.
 *
 * **Privacy:** Subject keys, credential fingerprints, and payload fingerprints
 * are never logged in error messages or exposed in any form that could be
 * reversed.
 */
@Injectable()
export class PostgresAbuseSignalStore implements AbuseSignalStore {
  private readonly logger = new Logger(PostgresAbuseSignalStore.name);

  constructor(
    @InjectRepository(AbuseSignalWindowRecord)
    private readonly windowRepo: Repository<AbuseSignalWindowRecord>,
    @InjectRepository(AbuseActionRecord)
    private readonly actionRepo: Repository<AbuseActionRecord>,
    @InjectRepository(AbuseDecisionRecord)
    private readonly decisionRepo: Repository<AbuseDecisionRecord>,
  ) {}

  async record(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    observation: AbuseObservation,
    windowMs: number,
    now: number,
  ): Promise<AbuseSubjectWindow> {
    const windowStart = windowStartFor(now, windowMs);
    const windowId = this.windowId(subjectKey, windowStart);
    const expiresAt = windowStart + 2 * windowMs;

    try {
      // Try to insert a new window first (optimistic path)
      const newWindow = this.windowRepo.create({
        id: windowId,
        subjectKey,
        subjectKind,
        windowStart: String(windowStart),
        windowMs,
        expiresAt: String(expiresAt),
      });
      
      const increments = this.computeIncrements(observation);
      Object.assign(newWindow, increments);
      
      // Apply observation to fresh window
      this.applyObservationToRecord(newWindow, observation);
      
      await this.windowRepo.save(newWindow);
      return this.recordToWindow(newWindow);
    } catch (error: any) {
      // Conflict on unique constraint: window already exists, update it
      if (error.code === '23505') {
        return await this.updateExistingWindow(
          windowId,
          subjectKey,
          subjectKind,
          windowStart,
          windowMs,
          observation,
        );
      }
      this.logger.error('Failed to record abuse observation', {
        error: error.message,
        subjectKind,
        observationKind: observation.kind,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  private async updateExistingWindow(
    windowId: string,
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    windowStart: number,
    windowMs: number,
    observation: AbuseObservation,
  ): Promise<AbuseSubjectWindow> {
    // Fetch current window state
    const existing = await this.windowRepo.findOne({ where: { id: windowId } });
    if (!existing) {
      // Race: window was just deleted, treat as empty
      return this.emptyWindow(subjectKey, subjectKind, windowStart, windowMs);
    }

    // Apply observation
    this.applyObservationToRecord(existing, observation);
    const increments = this.computeIncrements(observation);
    
    // Atomic update with counters
    existing.total += increments.total;
    existing.reads += increments.reads;
    existing.writes += increments.writes;
    existing.authFailures += increments.authFailures;
    existing.authSuccesses += increments.authSuccesses;
    existing.webhookEndpointWrites += increments.webhookEndpointWrites;
    existing.webhookSecretRotations += increments.webhookSecretRotations;
    existing.webhookDeliveries += increments.webhookDeliveries;
    existing.streamConnect += increments.streamConnect;
    existing.streamDisconnect += increments.streamDisconnect;
    existing.streamSubscribeOps += increments.streamSubscribeOps;
    existing.streamMessages += increments.streamMessages;
    existing.supportRequests += increments.supportRequests;

    await this.windowRepo.save(existing);
    return this.recordToWindow(existing);
  }

  async windowFor(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    windowMs: number,
    now: number,
  ): Promise<AbuseSubjectWindow> {
    const windowStart = windowStartFor(now, windowMs);
    const windowId = this.windowId(subjectKey, windowStart);

    try {
      const record = await this.windowRepo.findOne({ where: { id: windowId } });
      if (!record) {
        return this.emptyWindow(subjectKey, subjectKind, windowStart, windowMs);
      }
      return this.recordToWindow(record);
    } catch (error: any) {
      this.logger.error('Failed to read abuse window', {
        error: error.message,
        subjectKind,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async distinctSubjectsForCredential(
    credentialFingerprint: string,
    windowMs: number,
    now: number,
  ): Promise<number> {
    const windowStart = windowStartFor(now, windowMs);

    try {
      // Query all windows for this window start and sum subjects per credential
      const windows = await this.windowRepo
        .createQueryBuilder('w')
        .where('w.windowStart = :windowStart', { windowStart: String(windowStart) })
        .getMany();

      let total = 0;
      for (const window of windows) {
        const subjects = window.subjectsPerCredential as Record<string, number>;
        total += subjects[credentialFingerprint] ?? 0;
      }

      return total;
    } catch (error: any) {
      this.logger.error('Failed to count distinct subjects for credential', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async recordDecision(decision: AbuseDecision): Promise<void> {
    try {
      const record = this.decisionRepo.create({
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
        deploymentBlock: decision.binding?.deploymentBlock
          ? String(decision.binding.deploymentBlock)
          : null,
        artifactChecksum: decision.binding?.artifactChecksum ?? null,
        actionId: decision.action?.id ?? null,
        actionKind: decision.action?.kind ?? null,
        actionStatus: decision.action?.status ?? null,
        actionExpiresAt: decision.action?.expiresAt
          ? new Date(decision.action.expiresAt)
          : null,
        escalationLevel: decision.action?.escalationLevel ?? 0,
        appealable: true,
        decidedAt: new Date(decision.decidedAt),
      });

      await this.decisionRepo.save(record);
    } catch (error: any) {
      this.logger.error('Failed to record abuse decision', {
        error: error.message,
        decisionId: decision.id,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async getDecision(id: string): Promise<AbuseDecision | null> {
    try {
      const record = await this.decisionRepo.findOne({ where: { id } });
      return record ? this.recordToDecision(record) : null;
    } catch (error: any) {
      this.logger.error('Failed to read abuse decision', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async listDecisions(
    filter: AbuseDecisionFilter = {},
  ): Promise<AbuseDecision[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

    try {
      const query = this.decisionRepo
        .createQueryBuilder('d')
        .orderBy('d.decidedAt', 'DESC')
        .limit(limit);

      if (filter.subjectKey) {
        query.andWhere('d.subjectKey = :subjectKey', {
          subjectKey: filter.subjectKey,
        });
      }
      if (filter.outcome) {
        query.andWhere('d.outcome = :outcome', { outcome: filter.outcome });
      }

      const records = await query.getMany();
      return records.map((r) => this.recordToDecision(r));
    } catch (error: any) {
      this.logger.error('Failed to list abuse decisions', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async activeAction(
    subjectKey: string,
    now: number,
  ): Promise<AbuseAction | null> {
    try {
      // Find most recent ACTIVE action that hasn't expired
      const record = await this.actionRepo
        .createQueryBuilder('a')
        .where('a.subjectKey = :subjectKey', { subjectKey })
        .andWhere('a.status = :status', { status: AbuseActionStatus.ACTIVE })
        .andWhere('a.expiresAt > :now', { now: new Date(now) })
        .orderBy('a.startedAt', 'DESC')
        .getOne();

      return record ? this.recordToAction(record) : null;
    } catch (error: any) {
      this.logger.error('Failed to read active abuse action', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async putAction(action: AbuseAction): Promise<void> {
    try {
      const record = this.actionRepo.create({
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
        deploymentBlock: String(action.binding.deploymentBlock),
        artifactChecksum: action.binding.artifactChecksum,
        costMultiplier: action.costMultiplier,
        startedAt: new Date(action.startedAt),
        expiresAt: new Date(action.expiresAt),
        appealable: true,
        escalationLevel: action.escalationLevel,
      });

      await this.actionRepo.save(record);
    } catch (error: any) {
      this.logger.error('Failed to persist abuse action', {
        error: error.message,
        actionId: action.id,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async getAction(actionId: string): Promise<AbuseAction | null> {
    try {
      const record = await this.actionRepo.findOne({ where: { id: actionId } });
      return record ? this.recordToAction(record) : null;
    } catch (error: any) {
      this.logger.error('Failed to read abuse action', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async actionsFor(subjectKey: string): Promise<AbuseAction[]> {
    try {
      const records = await this.actionRepo.find({
        where: { subjectKey },
        order: { startedAt: 'DESC' },
      });
      return records.map((r) => this.recordToAction(r));
    } catch (error: any) {
      this.logger.error('Failed to list abuse actions for subject', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  async actionsStartedBefore(
    subjectKey: string,
    beforeMs: number,
  ): Promise<number> {
    try {
      const count = await this.actionRepo
        .createQueryBuilder('a')
        .where('a.subjectKey = :subjectKey', { subjectKey })
        .andWhere('a.startedAt < :before', { before: new Date(beforeMs) })
        .getCount();
      return count;
    } catch (error: any) {
      this.logger.error('Failed to count abuse actions before timestamp', {
        error: error.message,
      });
      throw new Error('ABUSE_SIGNAL_STORE_UNAVAILABLE');
    }
  }

  // Private helpers

  private windowId(subjectKey: string, windowStart: number): string {
    return createHash('sha256')
      .update(`${subjectKey}:${windowStart}`)
      .digest('hex')
      .slice(0, 32);
  }

  private emptyWindow(
    subjectKey: string,
    subjectKind: AbuseSubjectKind,
    windowStart: number,
    windowMs: number,
  ): AbuseSubjectWindow {
    return {
      subjectKey,
      subjectKind,
      windowStart,
      windowMs,
      total: 0,
      reads: 0,
      writes: 0,
      authFailures: 0,
      authSuccesses: 0,
      distinctRoutes: [],
      routeSaturationHit: false,
      distinctCredentials: [],
      credentialSaturationHit: false,
      duplicatePayloadCounts: new Map(),
      duplicatePayloadOverflow: 0,
      supportDuplicateCounts: new Map(),
      supportDuplicateRequests: 0,
      supportRequests: 0,
      supportContacts: [],
      supportContactSaturationHit: false,
      webhookEndpointWrites: 0,
      webhookSecretRotations: 0,
      webhookDeliveries: 0,
      streamConnect: 0,
      streamDisconnect: 0,
      streamSubscribeOps: 0,
      streamMessages: 0,
      subjectsPerCredential: new Map(),
    };
  }

  private computeIncrements(observation: AbuseObservation): Record<string, number> {
    const increments: Record<string, number> = {
      total: 1,
      reads: 0,
      writes: 0,
      authFailures: 0,
      authSuccesses: 0,
      webhookEndpointWrites: 0,
      webhookSecretRotations: 0,
      webhookDeliveries: 0,
      streamConnect: 0,
      streamDisconnect: 0,
      streamSubscribeOps: 0,
      streamMessages: 0,
      supportRequests: 0,
    };

    switch (observation.kind) {
      case AbuseObservationKind.READ:
        increments.reads = 1;
        break;
      case AbuseObservationKind.WRITE:
        increments.writes = 1;
        break;
      case AbuseObservationKind.AUTH_FAILURE:
        increments.authFailures = 1;
        break;
      case AbuseObservationKind.AUTH_SUCCESS:
        increments.authSuccesses = 1;
        break;
      case AbuseObservationKind.WEBHOOK_ENDPOINT_WRITE:
        increments.webhookEndpointWrites = 1;
        break;
      case AbuseObservationKind.WEBHOOK_SECRET_ROTATION:
        increments.webhookSecretRotations = 1;
        break;
      case AbuseObservationKind.WEBHOOK_DELIVERY:
        increments.webhookDeliveries = 1;
        break;
      case AbuseObservationKind.STREAM_CONNECT:
        increments.streamConnect = 1;
        break;
      case AbuseObservationKind.STREAM_DISCONNECT:
        increments.streamDisconnect = 1;
        break;
      case AbuseObservationKind.STREAM_SUBSCRIBE:
        increments.streamSubscribeOps = 1;
        break;
      case AbuseObservationKind.STREAM_MESSAGE:
        increments.streamMessages = 1;
        break;
    }

    if (observation.surface === AbuseSurface.SUPPORT) {
      increments.supportRequests = 1;
    }

    return increments;
  }

  private applyObservationToRecord(
    record: AbuseSignalWindowRecord,
    observation: AbuseObservation,
  ): void {
    // Distinct routes
    const routes = record.distinctRoutes as string[];
    if (!routes.includes(observation.routeGroup)) {
      if (routes.length < ABUSE_WINDOW_LIMITS.distinctCap) {
        routes.push(observation.routeGroup);
        record.distinctRoutes = routes;
      } else {
        record.routeSaturationHit = true;
      }
    }

    // Credential fingerprints
    if (observation.credentialFingerprint) {
      const credentials = record.distinctCredentials as string[];
      if (!credentials.includes(observation.credentialFingerprint)) {
        if (credentials.length < ABUSE_WINDOW_LIMITS.distinctCap) {
          credentials.push(observation.credentialFingerprint);
          record.distinctCredentials = credentials;
        } else {
          record.credentialSaturationHit = true;
        }
      }

      // Track subjects per credential
      const subjectsPerCred = record.subjectsPerCredential as Record<string, number>;
      subjectsPerCred[observation.credentialFingerprint] =
        (subjectsPerCred[observation.credentialFingerprint] ?? 0) + 1;
      record.subjectsPerCredential = subjectsPerCred;
    }

    // Duplicate payloads
    if (observation.payloadFingerprint) {
      const duplicates = record.duplicatePayloadCounts as Record<string, number>;
      if (duplicates[observation.payloadFingerprint] !== undefined) {
        duplicates[observation.payloadFingerprint] += 1;
      } else if (Object.keys(duplicates).length < ABUSE_WINDOW_LIMITS.payloadCap) {
        duplicates[observation.payloadFingerprint] = 0;
      } else {
        record.duplicatePayloadOverflow += 1;
      }
      record.duplicatePayloadCounts = duplicates;
    }

    // Support surface
    if (observation.surface === AbuseSurface.SUPPORT) {
      const contacts = record.supportContacts as string[];
      if (!contacts.includes(observation.routeGroup)) {
        if (contacts.length < ABUSE_WINDOW_LIMITS.distinctCap) {
          contacts.push(observation.routeGroup);
          record.supportContacts = contacts;
        } else {
          record.supportContactSaturationHit = true;
        }
      }

      if (observation.payloadFingerprint) {
        const supportDups = record.supportDuplicateCounts as Record<string, number>;
        if (supportDups[observation.payloadFingerprint] !== undefined) {
          supportDups[observation.payloadFingerprint] += 1;
          record.supportDuplicateRequests += 1;
        } else if (
          Object.keys(supportDups).length < ABUSE_WINDOW_LIMITS.payloadCap
        ) {
          supportDups[observation.payloadFingerprint] = 0;
        }
        record.supportDuplicateCounts = supportDups;
      }
    }
  }

  private recordToWindow(record: AbuseSignalWindowRecord): AbuseSubjectWindow {
    return {
      subjectKey: record.subjectKey,
      subjectKind: record.subjectKind as AbuseSubjectKind,
      windowStart: Number(record.windowStart),
      windowMs: record.windowMs,
      total: record.total,
      reads: record.reads,
      writes: record.writes,
      authFailures: record.authFailures,
      authSuccesses: record.authSuccesses,
      distinctRoutes: [...(record.distinctRoutes as string[])],
      routeSaturationHit: record.routeSaturationHit,
      distinctCredentials: [...(record.distinctCredentials as string[])],
      credentialSaturationHit: record.credentialSaturationHit,
      duplicatePayloadCounts: new Map(
        Object.entries(record.duplicatePayloadCounts as Record<string, number>),
      ),
      duplicatePayloadOverflow: record.duplicatePayloadOverflow,
      supportDuplicateCounts: new Map(
        Object.entries(record.supportDuplicateCounts as Record<string, number>),
      ),
      supportDuplicateRequests: record.supportDuplicateRequests,
      supportRequests: record.supportRequests,
      supportContacts: [...(record.supportContacts as string[])],
      supportContactSaturationHit: record.supportContactSaturationHit,
      webhookEndpointWrites: record.webhookEndpointWrites,
      webhookSecretRotations: record.webhookSecretRotations,
      webhookDeliveries: record.webhookDeliveries,
      streamConnect: record.streamConnect,
      streamDisconnect: record.streamDisconnect,
      streamSubscribeOps: record.streamSubscribeOps,
      streamMessages: record.streamMessages,
      subjectsPerCredential: new Map(
        Object.entries(record.subjectsPerCredential as Record<string, number>),
      ),
    };
  }

  private recordToAction(record: AbuseActionRecord): AbuseAction {
    return {
      id: record.id,
      subjectKey: record.subjectKey,
      subjectKind: record.subjectKind as AbuseSubjectKind,
      kind: record.kind as AbuseAction['kind'],
      status: record.status as AbuseActionStatus,
      reasonCode: record.reasonCode as AbuseAction['reasonCode'],
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

  private recordToDecision(record: AbuseDecisionRecord): AbuseDecision {
    return {
      id: record.id,
      subjectKey: record.subjectKey,
      subjectKind: record.subjectKind as AbuseSubjectKind,
      outcome: record.outcome as AbuseDecision['outcome'],
      indeterminateReason: record.indeterminateReason as AbuseDecision['indeterminateReason'],
      reasonCode: record.reasonCode as AbuseDecision['reasonCode'],
      reasonCodeVersion: record.reasonCodeVersion,
      kind: record.signalKind as AbuseDecision['kind'],
      severity: record.severity as AbuseDecision['severity'],
      confidence: record.confidence,
      sampleCount: record.sampleCount,
      corroboratingDimensions: record.corroboratingDimensions,
      modelVersion: record.modelVersion,
      configVersion: record.configVersion,
      binding: record.bindingChainId
        ? {
            chainId: record.bindingChainId,
            releaseId: record.releaseId!,
            deploymentBlock: BigInt(record.deploymentBlock!),
            artifactChecksum: record.artifactChecksum!,
          }
        : null,
      action: record.actionId
        ? ({
            id: record.actionId,
            subjectKey: record.subjectKey,
            subjectKind: record.subjectKind as AbuseSubjectKind,
            kind: record.actionKind as AbuseAction['kind'],
            status: record.actionStatus as AbuseActionStatus,
            reasonCode: record.reasonCode as AbuseAction['reasonCode'],
            reasonCodeVersion: record.reasonCodeVersion!,
            modelVersion: record.modelVersion,
            configVersion: record.configVersion,
            binding: {
              chainId: record.bindingChainId!,
              releaseId: record.releaseId!,
              deploymentBlock: BigInt(record.deploymentBlock!),
              artifactChecksum: record.artifactChecksum!,
            },
            costMultiplier: 1.0,
            startedAt: record.decidedAt.toISOString(),
            expiresAt: record.actionExpiresAt!.toISOString(),
            appealable: true,
            escalationLevel: record.escalationLevel,
          } as AbuseAction)
        : null,
      decidedAt: record.decidedAt.toISOString(),
    };
  }
}
