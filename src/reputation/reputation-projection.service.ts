import { createHash } from 'node:crypto';

export interface ReputationProjectionAuthority {
  chainId: number;
  releaseId: string;
  artifactHash: string;
  contractAddress: string;
  finalizedThroughBlock: number;
  finalizedBlockHash: string;
}

export interface ReputationProjectionCompleteness {
  throughBlock: number;
  blockHash: string;
  isComplete: boolean;
}

interface ReputationEventBase {
  chainId: number;
  releaseId: string;
  artifactHash: string;
  contractAddress: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  userId: string;
  isCanonical: boolean;
  isFinalized: boolean;
}

export interface ReputationAdjustmentEvent extends ReputationEventBase {
  kind: 'adjustment';
  deltaUnits: string;
}

export interface ReputationDecayCheckpointEvent extends ReputationEventBase {
  kind: 'decay_checkpoint';
  numerator: string;
  denominator: string;
}

export type ReputationProjectionEvent =
  | ReputationAdjustmentEvent
  | ReputationDecayCheckpointEvent;

export interface ReputationDecayCheckpoint {
  eventId: string;
  userId: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  numerator: string;
  denominator: string;
  priorUnits: string;
  projectedUnits: string;
  chainId: number;
  releaseId: string;
  artifactHash: string;
  contractAddress: string;
}

export interface ReputationProjectionSnapshot {
  authority: ReputationProjectionAuthority;
  values: Record<string, string>;
  decayCheckpoints: ReputationDecayCheckpoint[];
  eventCount: number;
  digest: string;
}

export class ReputationProjectionService {
  private authority: ReputationProjectionAuthority;
  private events = new Map<string, ReputationProjectionEvent>();

  constructor(authority: ReputationProjectionAuthority) {
    this.validateAuthority(authority);
    this.authority = { ...authority };
  }

  applyFinalizedEvents(
    events: ReputationProjectionEvent[],
    completeness: ReputationProjectionCompleteness,
  ): ReputationProjectionSnapshot {
    this.validateCompleteness(this.authority, completeness);
    const candidate = new Map(this.events);
    this.addEvents(candidate, events, this.authority);

    const snapshot = this.project(candidate, this.authority);
    this.events = candidate;
    return snapshot;
  }

  rebuild(
    events: ReputationProjectionEvent[],
    authority: ReputationProjectionAuthority,
    completeness: ReputationProjectionCompleteness,
  ): ReputationProjectionSnapshot {
    this.validateAuthority(authority);
    this.validateCompleteness(authority, completeness);
    const candidate = new Map<string, ReputationProjectionEvent>();
    this.addEvents(candidate, events, authority);

    const snapshot = this.project(candidate, authority);
    this.authority = { ...authority };
    this.events = candidate;
    return snapshot;
  }

  rollback(
    orphanedBlockHashes: string[],
    authority: ReputationProjectionAuthority,
    completeness: ReputationProjectionCompleteness,
    replacementEvents: ReputationProjectionEvent[] = [],
  ): ReputationProjectionSnapshot {
    const orphaned = new Set(
      orphanedBlockHashes.map((hash) => hash.toLowerCase()),
    );
    const remaining = [...this.events.values()].filter(
      (event) => !orphaned.has(event.blockHash.toLowerCase()),
    );
    return this.rebuild(
      [...remaining, ...replacementEvents],
      authority,
      completeness,
    );
  }

  getSnapshot(): ReputationProjectionSnapshot {
    return this.project(this.events, this.authority);
  }

  private addEvents(
    target: Map<string, ReputationProjectionEvent>,
    events: ReputationProjectionEvent[],
    authority: ReputationProjectionAuthority,
  ): void {
    const occupiedLogs = new Map<string, string>();
    const canonicalBlockHashes = new Map<number, string>();

    for (const existing of target.values()) {
      occupiedLogs.set(this.logKey(existing), this.eventId(existing));
      canonicalBlockHashes.set(
        existing.blockNumber,
        existing.blockHash.toLowerCase(),
      );
    }

    for (const event of events) {
      this.validateEvent(event, authority);
      const eventId = this.eventId(event);
      const previous = target.get(eventId);
      if (previous) {
        if (this.serializeEvent(previous) !== this.serializeEvent(event)) {
          throw new Error(`Conflicting duplicate reputation event: ${eventId}`);
        }
        continue;
      }

      const canonicalBlockHash = canonicalBlockHashes.get(event.blockNumber);
      if (
        canonicalBlockHash &&
        canonicalBlockHash !== event.blockHash.toLowerCase()
      ) {
        throw new Error(
          `Ambiguous canonical block hash at ${event.blockNumber}`,
        );
      }

      const logKey = this.logKey(event);
      const occupyingEventId = occupiedLogs.get(logKey);
      if (occupyingEventId) {
        throw new Error(`Ambiguous canonical log position: ${logKey}`);
      }

      occupiedLogs.set(logKey, eventId);
      canonicalBlockHashes.set(
        event.blockNumber,
        event.blockHash.toLowerCase(),
      );
      target.set(eventId, { ...event });
    }
  }

  private project(
    sourceEvents: Map<string, ReputationProjectionEvent>,
    authority: ReputationProjectionAuthority,
  ): ReputationProjectionSnapshot {
    const orderedEvents = [...sourceEvents.values()].sort(
      (left, right) =>
        left.blockNumber - right.blockNumber ||
        left.transactionIndex - right.transactionIndex ||
        left.logIndex - right.logIndex,
    );
    const values = new Map<string, bigint>();
    const decayCheckpoints: ReputationDecayCheckpoint[] = [];

    for (const event of orderedEvents) {
      const current = values.get(event.userId) ?? 0n;
      if (event.kind === 'adjustment') {
        values.set(event.userId, current + BigInt(event.deltaUnits));
        continue;
      }

      const numerator = BigInt(event.numerator);
      const denominator = BigInt(event.denominator);
      const projected = (current * numerator) / denominator;
      values.set(event.userId, projected);
      decayCheckpoints.push({
        eventId: this.eventId(event),
        userId: event.userId,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        numerator: event.numerator,
        denominator: event.denominator,
        priorUnits: current.toString(),
        projectedUnits: projected.toString(),
        chainId: event.chainId,
        releaseId: event.releaseId,
        artifactHash: event.artifactHash,
        contractAddress: event.contractAddress,
      });
    }

    const serializedValues = Object.fromEntries(
      [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([userId, value]) => [userId, value.toString()]),
    );
    const digestPayload = JSON.stringify({
      authority,
      events: orderedEvents.map((event) => this.serializeEvent(event)),
      values: serializedValues,
      decayCheckpoints,
    });

    return {
      authority: { ...authority },
      values: serializedValues,
      decayCheckpoints,
      eventCount: orderedEvents.length,
      digest: createHash('sha256').update(digestPayload).digest('hex'),
    };
  }

  private validateAuthority(authority: ReputationProjectionAuthority): void {
    if (!Number.isSafeInteger(authority.chainId) || authority.chainId <= 0) {
      throw new Error('Invalid reputation projection chain ID');
    }
    if (!authority.releaseId.trim()) {
      throw new Error('Missing reputation projection release ID');
    }
    if (!this.isHash(authority.artifactHash)) {
      throw new Error('Invalid reputation projection artifact hash');
    }
    if (!this.isAddress(authority.contractAddress)) {
      throw new Error('Invalid reputation projection contract address');
    }
    if (
      !Number.isSafeInteger(authority.finalizedThroughBlock) ||
      authority.finalizedThroughBlock < 0
    ) {
      throw new Error('Invalid finalized reputation projection block');
    }
    if (!this.isHash(authority.finalizedBlockHash)) {
      throw new Error('Invalid finalized reputation projection block hash');
    }
  }

  private validateCompleteness(
    authority: ReputationProjectionAuthority,
    completeness: ReputationProjectionCompleteness,
  ): void {
    if (
      completeness.isComplete !== true ||
      completeness.throughBlock !== authority.finalizedThroughBlock ||
      completeness.blockHash.toLowerCase() !==
        authority.finalizedBlockHash.toLowerCase()
    ) {
      throw new Error('Reputation source snapshot is incomplete or stale');
    }
  }

  private validateEvent(
    event: ReputationProjectionEvent,
    authority: ReputationProjectionAuthority,
  ): void {
    if (
      event.chainId !== authority.chainId ||
      event.releaseId !== authority.releaseId ||
      event.artifactHash.toLowerCase() !==
        authority.artifactHash.toLowerCase() ||
      event.contractAddress.toLowerCase() !==
        authority.contractAddress.toLowerCase()
    ) {
      throw new Error('Unauthorized reputation event provenance');
    }
    if (
      event.isCanonical !== true ||
      event.isFinalized !== true ||
      !Number.isSafeInteger(event.blockNumber) ||
      event.blockNumber < 0 ||
      event.blockNumber > authority.finalizedThroughBlock
    ) {
      throw new Error(
        'Reputation event is not in the finalized canonical range',
      );
    }
    if (
      !Number.isSafeInteger(event.transactionIndex) ||
      event.transactionIndex < 0 ||
      !Number.isSafeInteger(event.logIndex) ||
      event.logIndex < 0
    ) {
      throw new Error('Invalid reputation event ordering metadata');
    }
    if (
      !this.isHash(event.blockHash) ||
      !this.isHash(event.transactionHash) ||
      !event.userId.trim()
    ) {
      throw new Error('Incomplete reputation event provenance');
    }
    if (
      event.blockNumber === authority.finalizedThroughBlock &&
      event.blockHash.toLowerCase() !==
        authority.finalizedBlockHash.toLowerCase()
    ) {
      throw new Error(
        'Reputation event conflicts with the finalized block anchor',
      );
    }
    if (event.kind === 'adjustment') {
      if (!this.isInteger(event.deltaUnits)) {
        throw new Error('Invalid integer reputation adjustment');
      }
      return;
    }

    if (
      event.kind !== 'decay_checkpoint' ||
      !this.isUnsignedInteger(event.numerator) ||
      !this.isUnsignedInteger(event.denominator) ||
      BigInt(event.denominator) === 0n ||
      BigInt(event.numerator) > BigInt(event.denominator)
    ) {
      throw new Error('Invalid reputation decay checkpoint');
    }
  }

  private eventId(event: ReputationProjectionEvent): string {
    return `${event.chainId}:${event.blockHash.toLowerCase()}:${event.logIndex}`;
  }

  private logKey(event: ReputationProjectionEvent): string {
    return `${event.chainId}:${event.blockNumber}:${event.logIndex}`;
  }

  private serializeEvent(event: ReputationProjectionEvent): string {
    const common = [
      event.kind,
      event.chainId,
      event.releaseId,
      event.artifactHash.toLowerCase(),
      event.contractAddress.toLowerCase(),
      event.blockNumber,
      event.blockHash.toLowerCase(),
      event.transactionHash.toLowerCase(),
      event.transactionIndex,
      event.logIndex,
      event.userId,
      event.isCanonical,
      event.isFinalized,
    ];
    return JSON.stringify(
      event.kind === 'adjustment'
        ? [...common, event.deltaUnits]
        : [...common, event.numerator, event.denominator],
    );
  }

  private isHash(value: string): boolean {
    return /^0x[0-9a-f]{64}$/i.test(value);
  }

  private isAddress(value: string): boolean {
    return /^0x[0-9a-f]{40}$/i.test(value);
  }

  private isInteger(value: string): boolean {
    return /^-?(0|[1-9][0-9]*)$/.test(value);
  }

  private isUnsignedInteger(value: string): boolean {
    return /^(0|[1-9][0-9]*)$/.test(value);
  }
}
