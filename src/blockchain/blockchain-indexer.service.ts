import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@typeorm/nestjs';
import {
  Repository,
  DataSource,
  EntityManager,
  MoreThanOrEqual,
} from 'typeorm';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainStateService } from './state.service';
import {
  BlockchainEvent,
  TransferEventData,
} from './interfaces/blockchain-event.interface';
import { ClaimsCache } from '../cache/claims.cache';
import { SequentialQueue } from './utils/sequential-queue';
import { ReadinessService } from '../readiness/readiness.service';
import { createHmac, timingSafeEqual } from 'crypto';
import { InboundWebhookDelivery } from './entities/inbound-webhook-delivery.entity';

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookProviderConfig {
  /** Provider identifier (e.g. 'stripe', 'github'). */
  provider: string;
  /** Current active signing secret. */
  secret: string;
  /** Previous secrets still valid during rotation. */
  previousSecrets?: string[];
  /** Maximum allowed clock skew for the signed timestamp. */
  timestampToleranceSeconds?: number;
  /** Maximum accepted raw body size in bytes. */
  maxBodyBytes?: number;
  /**
   * Derive the canonical signed bytes for this provider. This must be
   * deterministic and operate on the raw request body bytes (not a
   * re-serialised JSON object) so that any body mutation invalidates the
   * signature.
   */
  signedBytes: (context: WebhookSigningContext) => Buffer;
}

export interface WebhookSigningContext {
  /** Raw request body bytes exactly as received. */
  rawBody: Buffer;
  /** Signed timestamp as provided by the provider (unix seconds). */
  timestamp: number;
  /** Delivery ID for deduplication. */
  deliveryId: string;
  /** Provider identifier. */
  provider: string;
}

export interface InboundWebhookRequest {
  /** Provider identifier from the route/header. */
  provider: string;
  /** Raw request body bytes. */
  rawBody: Buffer;
  /** Signature header value (hex). */
  signature: string;
  /** Timestamp header value (unix seconds). */
  timestamp: number;
  /** Delivery ID header value. */
  deliveryId: string;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export class WebhookReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookReplayError';
  }
}

export class WebhookPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookPayloadTooLargeError';
  }
}

export class UnknownWebhookProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownWebhookProviderError';
  }
}

@Injectable()
export class BlockchainIndexerService {
  private readonly logger = new Logger(BlockchainIndexerService.name);

  /**
   * Serialises every state mutation (event processing and reorg rollbacks) so
   * they are applied strictly in order and never interleave. Without this, a
   * reorg rollback could race against a newer block's transaction and leave
   * balances or the checkpoint desynced.
   */
  private readonly queue = new SequentialQueue();

  /** Registered webhook provider configurations, keyed by provider id. */
  private readonly webhookProviders: Map<string, WebhookProviderConfig> =
    new Map();

  constructor(
    @InjectRepository(ProcessedEvent)
    private processedEventRepo: Repository<ProcessedEvent>,
    @InjectRepository(TokenBalance)
    private tokenBalanceRepo: Repository<TokenBalance>,
    @InjectRepository(IndexerCheckpoint)
    private checkpointRepo: Repository<IndexerCheckpoint>,
    @InjectRepository(InboundWebhookDelivery)
    private webhookDeliveryRepo: Repository<InboundWebhookDelivery>,
    private dataSource: DataSource,
    private stateService: BlockchainStateService,
    private claimsCache: ClaimsCache,
    private readinessService: ReadinessService,
  ) {}

  /**
   * Register a webhook provider configuration. Unknown providers fail closed
   * at verification time because no config is registered for them.
   */
  registerWebhookProvider(config: WebhookProviderConfig): void {
    if (!config.provider || !config.secret) {
      throw new UnknownWebhookProviderError(
        'Webhook provider configuration requires provider and secret',
      );
    }
    this.webhookProviders.set(config.provider, { ...config });
  }

  /**
   * Verify an inbound webhook request and record its delivery ID transactionally.
   *
   * The raw request body is preserved and fed into the provider-specific
   * signed-bytes derivation. Signature comparison is constant-time and the
   * timestamp must be within tolerance. Delivery IDs are unique; a duplicate
   * is rejected transactionally via a unique constraint and an explicit
   * check inside the same transaction.
   */
  async verifyInboundWebhook(
    request: InboundWebhookRequest,
  ): Promise<void> {
    const config = this.webhookProviders.get(request.provider);
    if (!config) {
      // Unknown providers fail closed.
      throw new UnknownWebhookProviderError(
        `Unknown webhook provider: ${request.provider}`,
      );
    }

    const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
    if (request.rawBody.length > maxBodyBytes) {
      throw new WebhookPayloadTooLargeError(
        `Webhook body exceeds ${maxBodyBytes} bytes`,
      );
    }

    const tolerance =
      config.timestampToleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(request.timestamp)) {
      throw new WebhookSignatureError('Invalid webhook timestamp');
    }
    if (Math.abs(nowSeconds - request.timestamp) > tolerance) {
      throw new WebhookSignatureError('Webhook timestamp outside tolerance');
    }

    if (!request.deliveryId) {
      throw new WebhookSignatureError('Missing webhook delivery ID');
    }

    const signedBytes = config.signedBytes({
      rawBody: request.rawBody,
      timestamp: request.timestamp,
      deliveryId: request.deliveryId,
      provider: request.provider,
    });

    const candidateSecrets = [config.secret, ...(config.previousSecrets ?? [])];
    const providedSignature = Buffer.from(request.signature ?? '', 'hex');
    if (providedSignature.length === 0) {
      throw new WebhookSignatureError('Missing webhook signature');
    }

    let signatureValid = false;
    for (const secret of candidateSecrets) {
      const expected = createHmac('sha256', secret).update(signedBytes).digest();
      if (
        expected.length === providedSignature.length &&
        timingSafeEqual(expected, providedSignature)
      ) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) {
      throw new WebhookSignatureError('Invalid webhook signature');
    }

    // Reject replays transactionally: the delivery ID is unique and the
    // insert commits atomically with the duplicate check.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const existing = await queryRunner.manager.findOne(InboundWebhookDelivery, {
        where: { provider: request.provider, deliveryId: request.deliveryId },
      });
      if (existing) {
        throw new WebhookReplayError('Duplicate webhook delivery ID');
      }

      const record = queryRunner.manager.create(InboundWebhookDelivery, {
        provider: request.provider,
        deliveryId: request.deliveryId,
        timestamp: request.timestamp,
        receivedAt: new Date(),
      });
      await queryRunner.manager.save(InboundWebhookDelivery, record);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      // Never log the secret or signature material.
      this.logger.warn(
        `Webhook verification failed for provider ${request.provider}`,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Process a single blockchain event. Enqueued so events are persisted one at
   * a time, in submission order.
   */
  async processEvent(event: BlockchainEvent): Promise<void> {
    return this.queue.enqueue(() => this.processEventInternal(event));
  }

  private async processEventInternal(event: BlockchainEvent): Promise<void> {
    const { txHash, logIndex, blockNumber, eventType, data } = event;

    // Idempotency: an event is uniquely identified by (txHash, logIndex).
    // Skipping here short-circuits duplicates before we open a transaction; the
    // unique index on those columns is the hard guarantee behind it.
    const existing = await this.processedEventRepo.findOne({
      where: { txHash, logIndex },
    });

    if (existing) {
      this.logger.log(`Event already processed: ${txHash}:${logIndex}`);
      return;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Persist the event record. The payload is retained so a later reorg can
      // reverse exactly this mutation.
      const processedEvent = this.processedEventRepo.create({
        txHash,
        logIndex,
        blockNumber,
        eventType,
        payload: data ?? null,
      });
      await queryRunner.manager.save(ProcessedEvent, processedEvent);

      // Apply the state mutation for this event type, and track which
      // claims (if any) it actually affects so cache invalidation below
      // can be projection-aware instead of a blanket flush on every
      // event. `undefined` (the SequentialQueue's other event types, once
      // added, that haven't been taught to report their affected claims
      // yet) still falls back to the safe "invalidate everything" default
      // in ClaimsCache.invalidateForProjectionUpdate.
      let affectedClaimIds: string[] | undefined;
      if (eventType === 'Transfer') {
        await this.applyTransfer(
          queryRunner.manager,
          data as TransferEventData,
        );
        // A Transfer only mutates TokenBalance rows, which the claims
        // cache never reflects, so no claim is affected by this event.
        affectedClaimIds = [];
      }

      // Advance the checkpoint inside the same transaction so the event, the
      // balance changes and the checkpoint all commit atomically. If anything
      // fails we roll back as a unit and the checkpoint never moves.
      await this.saveCheckpoint(queryRunner.manager, blockNumber);

      await queryRunner.commitTransaction();
      this.logger.log(`Processed event: ${eventType} at block ${blockNumber}`);

      // Record a fresh successful observation so readiness reflects the
      // indexer's liveness and projection progress. A stale last-success
      // (no recent observation) must never report healthy.
      await this.readinessService.recordIndexerObservation({
        observedAt: new Date(),
        lastSuccessAt: new Date(),
        blockNumber,
      });

      // Invalidate cache after successfully committing a projection change.
      // Passing the actual affected claim IDs (an empty array included)
      // is what makes this projection-aware: a Transfer event no longer
      // pays for (and risks the thundering-herd effect of) flushing the
      // entire claims cache on every single indexed event.
      await this.claimsCache.invalidateForProjectionUpdate(affectedClaimIds);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to process event ${txHash}:${logIndex}: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async applyTransfer(
    manager: EntityManager,
    data: TransferEventData,
  ): Promise<void> {
    const { from, to, amount, token } = data;

    if (from) {
      const fromBalance = await manager.findOne(TokenBalance, {
        where: { address: from, token },
      });
      if (fromBalance) {
        fromBalance.balance = (
          BigInt(fromBalance.balance) - BigInt(amount)
        ).toString();
        await manager.save(TokenBalance, fromBalance);
      }
    }

    if (to) {
      let toBalance = await manager.findOne(TokenBalance, {
        where: { address: to, token },
      });
      if (!toBalance) {
        toBalance = manager.create(TokenBalance, {
          address: to,
          token,
          balance: '0',
        });
      }
      toBalance.balance = (BigInt(toBalance.balance) + BigInt(amount)).toString();
      await manager.save(TokenBalance, toBalance);
    }
  }

  private async saveCheckpoint(
    manager: EntityManager,
    blockNumber: number,
  ): Promise<void> {
    const checkpoint = await manager.findOne(IndexerCheckpoint, {
      where: { id: 1 },
    });
    if (checkpoint) {
      if (blockNumber > checkpoint.blockNumber) {
        checkpoint.blockNumber = blockNumber;
        await manager.save(IndexerCheckpoint, checkpoint);
      }
    } else {
      const newCheckpoint = manager.create(IndexerCheckpoint, {
        id: 1,
        blockNumber,
      });
      await manager.save(IndexerCheckpoint, newCheckpoint);
    }
  }
}
