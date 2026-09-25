// src/indexer/projector-checkpoint.service.ts
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { randomBytes, createHash } from 'crypto';

export interface ProjectorCheckpoint {
  id: string;
  projectorName: string;
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: bigint;
  lastProcessedLogIndex: number;
  lastProcessedTxHash: string;
  status: 'idle' | 'running' | 'paused' | 'error';
  errorMessage?: string;
  batchSize: number;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  processedCount: number;
  failedCount: number;
}

export interface CheckpointOptions {
  projectorName: string;
  chainId: number;
  contractAddress: string;
  batchSize?: number;
  leaseDurationMs?: number;
}

export interface CheckpointResult {
  checkpoint: ProjectorCheckpoint;
  acquired: boolean;
  isNew: boolean;
}

/**
 * Resumable Projector Checkpoints Service
 *
 * Checkpoints each projector independently with deterministic restart,
 * bounded batches, lease ownership, and stale-lease recovery.
 *
 * Implements V2-BE-055: Add Resumable Projector Checkpoints
 */
@Injectable()
export class ProjectorCheckpointService {
  private readonly logger = new Logger(ProjectorCheckpointService.name);
  private readonly DEFAULT_BATCH_SIZE = 100;
  private readonly DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  private readonly STALE_LEASE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Acquire or create a checkpoint for a projector
   * Uses lease mechanism to prevent concurrent processing
   */
  async acquireCheckpoint(options: CheckpointOptions): Promise<CheckpointResult> {
    const { projectorName, chainId, contractAddress, batchSize = this.DEFAULT_BATCH_SIZE, leaseDurationMs = this.DEFAULT_LEASE_DURATION_MS } = options;
    const normalizedContract = contractAddress.toLowerCase();
    const leaseOwner = this.generateLeaseId();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Try to acquire lease on existing checkpoint
      const existing = await this.findCheckpoint(queryRunner, projectorName, chainId, normalizedContract);

      if (existing) {
        // Check if lease is stale or expired
        const isLeaseStale = existing.leaseExpiresAt && new Date() > existing.leaseExpiresAt;
        const isLeaseExpired = existing.leaseExpiresAt && new Date() > new Date(existing.leaseExpiresAt.getTime() + this.STALE_LEASE_THRESHOLD_MS);

        if (existing.leaseOwner && !isLeaseStale && !isLeaseExpired) {
          // Lease is held by another process
          this.logger.debug(`Checkpoint lease held by ${existing.leaseOwner} for ${projectorName}`);
          return {
            checkpoint: existing,
            acquired: false,
            isNew: false,
          };
        }

        // Lease is stale or expired, try to acquire it
        const now = new Date();
        const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);

        await queryRunner.query(
          `UPDATE "v2_projector_checkpoints" 
          SET "lease_owner" = $1, "lease_expires_at" = $2, "status" = 'running', "updated_at" = NOW()
          WHERE "id" = $3 AND ("lease_owner" IS NULL OR "lease_expires_at" <= NOW())`,
          [leaseOwner, leaseExpiresAt, existing.id]
        );

        // Check if update succeeded
        const updated = await this.findCheckpoint(queryRunner, projectorName, chainId, normalizedContract);

        if (updated && updated.leaseOwner === leaseOwner) {
          await queryRunner.commitTransaction();
          this.logger.log(`Acquired stale lease for projector: ${projectorName} on chain ${chainId}`);
          return {
            checkpoint: updated,
            acquired: true,
            isNew: false,
          };
        }

        // Failed to acquire, another process got it
        await queryRunner.rollbackTransaction();
        return {
          checkpoint: existing,
          acquired: false,
          isNew: false,
        };
      }

      // Create new checkpoint
      const now = new Date();
      const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
      const id = randomBytes(16).toString('hex');

      await queryRunner.query(
        `INSERT INTO "v2_projector_checkpoints" 
        ("id", "projector_name", "chain_id", "contract_address", "last_processed_block", "last_processed_log_index", "last_processed_tx_hash", "status", "batch_size", "lease_owner", "lease_expires_at", "created_at", "updated_at", "processed_count", "failed_count")
        VALUES ($1, $2, $3, $4, 0, -1, '', 'running', $5, $6, $7, NOW(), NOW(), 0, 0)`,
        [id, projectorName, chainId, normalizedContract, batchSize, leaseOwner, leaseExpiresAt]
      );

      const newCheckpoint = await this.findCheckpoint(queryRunner, projectorName, chainId, normalizedContract);

      await queryRunner.commitTransaction();

      this.logger.log(`Created new checkpoint for projector: ${projectorName} on chain ${chainId}`);

      return {
        checkpoint: newCheckpoint!,
        acquired: true,
        isNew: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to acquire checkpoint for ${projectorName}: ${error.message}`);
      throw new InternalServerErrorException('Failed to acquire projector checkpoint');
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Update checkpoint after processing a batch
   */
  async updateCheckpoint(
    checkpointId: string,
    updates: {
      lastProcessedBlock?: bigint;
      lastProcessedLogIndex?: number;
      lastProcessedTxHash?: string;
      processedIncrement?: number;
      failedIncrement?: number;
      status?: 'idle' | 'running' | 'paused' | 'error';
      errorMessage?: string;
    },
  ): Promise<ProjectorCheckpoint | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const setParts: string[] = ['"updated_at" = NOW()'];
      const values: any[] = [];
      let paramIndex = 1;

      if (updates.lastProcessedBlock !== undefined) {
        setParts.push(`"last_processed_block" = $${paramIndex++}`);
        values.push(updates.lastProcessedBlock);
      }
      if (updates.lastProcessedLogIndex !== undefined) {
        setParts.push(`"last_processed_log_index" = $${paramIndex++}`);
        values.push(updates.lastProcessedLogIndex);
      }
      if (updates.lastProcessedTxHash !== undefined) {
        setParts.push(`"last_processed_tx_hash" = $${paramIndex++}`);
        values.push(updates.lastProcessedTxHash);
      }
      if (updates.processedIncrement !== undefined) {
        setParts.push(`"processed_count" = "processed_count" + $${paramIndex++}`);
        values.push(updates.processedIncrement);
      }
      if (updates.failedIncrement !== undefined) {
        setParts.push(`"failed_count" = "failed_count" + $${paramIndex++}`);
        values.push(updates.failedIncrement);
      }
      if (updates.status !== undefined) {
        setParts.push(`"status" = $${paramIndex++}`);
        values.push(updates.status);
      }
      if (updates.errorMessage !== undefined) {
        setParts.push(`"error_message" = $${paramIndex++}`);
        values.push(updates.errorMessage);
      }

      values.push(checkpointId);

      await queryRunner.query(
        `UPDATE "v2_projector_checkpoints" SET ${setParts.join(', ')} WHERE "id" = $${paramIndex}`,
        values
      );

      await queryRunner.commitTransaction();

      return this.getCheckpointById(checkpointId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to update checkpoint ${checkpointId}: ${error.message}`);
      throw new InternalServerErrorException('Failed to update projector checkpoint');
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Release lease on checkpoint
   */
  async releaseCheckpoint(checkpointId: string, leaseOwner: string): Promise<boolean> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(
        `UPDATE "v2_projector_checkpoints" 
        SET "lease_owner" = NULL, "lease_expires_at" = NULL, "status" = 'idle', "updated_at" = NOW()
        WHERE "id" = $1 AND "lease_owner" = $2`,
        [checkpointId, leaseOwner]
      );

      await queryRunner.commitTransaction();
      return (result.affectedRows || 0) > 0;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to release checkpoint ${checkpointId}: ${error.message}`);
      return false;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Recover stale leases (can be run as cron job)
   */
  async recoverStaleLeases(): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(
        `UPDATE "v2_projector_checkpoints" 
        SET "lease_owner" = NULL, "lease_expires_at" = NULL, "status" = 'idle', "updated_at" = NOW()
        WHERE "lease_expires_at" IS NOT NULL AND "lease_expires_at" < NOW() - INTERVAL '${this.STALE_LEASE_THRESHOLD_MS} milliseconds'`
      );

      await queryRunner.commitTransaction();
      const recovered = result.affectedRows || 0;

      if (recovered > 0) {
        this.logger.log(`Recovered ${recovered} stale projector leases`);
      }

      return recovered;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to recover stale leases: ${error.message}`);
      return 0;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get checkpoint by projector details
   */
  async getCheckpoint(projectorName: string, chainId: number, contractAddress: string): Promise<ProjectorCheckpoint | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      return this.findCheckpoint(queryRunner, projectorName, chainId, contractAddress.toLowerCase());
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get checkpoint by ID
   */
  async getCheckpointById(id: string): Promise<ProjectorCheckpoint | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(
        `SELECT * FROM "v2_projector_checkpoints" WHERE "id" = $1`,
        [id]
      );
      return result[0] ? this.mapToCheckpoint(result[0]) : null;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * List all checkpoints for a projector
   */
  async listCheckpoints(projectorName: string): Promise<ProjectorCheckpoint[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(
        `SELECT * FROM "v2_projector_checkpoints" WHERE "projector_name" = $1 ORDER BY "updated_at" DESC`,
        [projectorName]
      );
      return result.map(this.mapToCheckpoint);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get checkpoint statistics
   */
  async getCheckpointStats(projectorName: string): Promise<{
    totalProcessed: number;
    totalFailed: number;
    currentBlock: bigint;
    status: string;
    lastUpdated: Date;
  } | null> {
    const checkpoint = await this.getCheckpoint(projectorName, 0, ''); // Will need proper query
    if (!checkpoint) return null;

    return {
      totalProcessed: checkpoint.processedCount,
      totalFailed: checkpoint.failedCount,
      currentBlock: checkpoint.lastProcessedBlock,
      status: checkpoint.status,
      lastUpdated: checkpoint.updatedAt,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async findCheckpoint(
    queryRunner: QueryRunner,
    projectorName: string,
    chainId: number,
    contractAddress: string,
  ): Promise<ProjectorCheckpoint | null> {
    const result = await queryRunner.query(
      `SELECT * FROM "v2_projector_checkpoints" 
      WHERE "projector_name" = $1 AND "chain_id" = $2 AND "contract_address" = $3`,
      [projectorName, chainId, contractAddress]
    );
    return result[0] ? this.mapToCheckpoint(result[0]) : null;
  }

  private mapToCheckpoint(row: any): ProjectorCheckpoint {
    return {
      id: row.id,
      projectorName: row.projector_name,
      chainId: parseInt(row.chain_id, 10),
      contractAddress: row.contract_address,
      lastProcessedBlock: row.last_processed_block ? BigInt(row.last_processed_block) : BigInt(0),
      lastProcessedLogIndex: parseInt(row.last_processed_log_index, 10),
      lastProcessedTxHash: row.last_processed_tx_hash,
      status: row.status,
      errorMessage: row.error_message,
      batchSize: parseInt(row.batch_size, 10),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      processedCount: parseInt(row.processed_count, 10),
      failedCount: parseInt(row.failed_count, 10),
    };
  }

  private generateLeaseId(): string {
    return `lease-${randomBytes(8).toString('hex')}`;
  }
}