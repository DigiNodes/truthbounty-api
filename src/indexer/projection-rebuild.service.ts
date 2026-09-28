// src/indexer/projection-rebuild.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { createHash, randomBytes } from 'crypto';

export interface RebuildDigest {
  id: string;
  projectionName: string;
  datasetHash: string;
  recordCount: number;
  blockRangeStart: bigint;
  blockRangeEnd: bigint;
  rebuiltAt: Date;
  rebuildType: 'incremental' | 'full';
  previousDigestId?: string;
  metadata?: Record<string, any>;
}

export interface DigestComparison {
  projectionName: string;
  incrementalDigest: RebuildDigest;
  fullRebuildDigest: RebuildDigest;
  isEquivalent: boolean;
  differences?: Array<{
    field: string;
    incrementalValue: any;
    fullRebuildValue: any;
  }>;
}

/**
 * Projection Rebuild Digest Service
 *
 * Hashes normalized rebuilt datasets and compares incremental versus
 * clean rebuild results for deterministic equivalence.
 *
 * Implements V2-BE-056: Generate Projection Rebuild Digests
 */
@Injectable()
export class ProjectionRebuildService {
  private readonly logger = new Logger(ProjectionRebuildService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Generate a digest for a rebuilt projection dataset
   */
  async generateDigest(
    projectionName: string,
    queryRunner: QueryRunner,
    options: {
      blockRangeStart: bigint;
      blockRangeEnd: bigint;
      rebuildType: 'incremental' | 'full';
      previousDigestId?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<RebuildDigest> {
    const { blockRangeStart, blockRangeEnd, rebuildType, previousDigestId, metadata } = options;

    // Fetch all records for the projection in the block range
    const records = await queryRunner.query(
      `SELECT * FROM "v2_projections" 
      WHERE "entity_type" = $1 AND "updated_at_block" BETWEEN $2 AND $3
      ORDER BY "entity_id"`,
      [projectionName, blockRangeStart, blockRangeEnd]
    );

    // Normalize records for deterministic hashing
    const normalizedRecords = this.normalizeRecords(records);

    // Compute dataset hash
    const datasetHash = this.computeDatasetHash(normalizedRecords);

    // Create digest record
    const digest: RebuildDigest = {
      id: randomBytes(16).toString('hex'),
      projectionName,
      datasetHash,
      recordCount: normalizedRecords.length,
      blockRangeStart,
      blockRangeEnd,
      rebuiltAt: new Date(),
      rebuildType,
      previousDigestId,
      metadata,
    };

    // Store digest
    await queryRunner.query(
      `INSERT INTO "v2_projection_digests" 
      ("id", "projection_name", "dataset_hash", "record_count", "block_range_start", "block_range_end", "rebuilt_at", "rebuild_type", "previous_digest_id", "metadata")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        digest.id,
        digest.projectionName,
        digest.datasetHash,
        digest.recordCount,
        digest.blockRangeStart,
        digest.blockRangeEnd,
        digest.rebuiltAt,
        digest.rebuildType,
        digest.previousDigestId || null,
        JSON.stringify(digest.metadata || {}),
      ]
    );

    this.logger.log(
      `Generated ${rebuildType} digest for ${projectionName}: ${digest.datasetHash.slice(0, 16)}... (${normalizedRecords.length} records)`
    );

    return digest;
  }

  /**
   * Compare incremental and full rebuild digests
   */
  async compareDigests(
    projectionName: string,
    incrementalDigestId: string,
    fullRebuildDigestId: string,
  ): Promise<DigestComparison> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const [incremental, fullRebuild] = await Promise.all([
        this.getDigestById(queryRunner, incrementalDigestId),
        this.getDigestById(queryRunner, fullRebuildDigestId),
      ]);

      if (!incremental || !fullRebuild) {
        throw new Error('One or both digests not found');
      }

      if (incremental.projectionName !== projectionName || fullRebuild.projectionName !== projectionName) {
        throw new Error('Digest projection name mismatch');
      }

      const isEquivalent = incremental.datasetHash === fullRebuild.datasetHash;

      let differences: Array<{ field: string; incrementalValue: any; fullRebuildValue: any }> | undefined;

      if (!isEquivalent) {
        // For detailed diff, we'd need to fetch and compare records
        // For now, report high-level differences
        differences = [
          {
            field: 'datasetHash',
            incrementalValue: incremental.datasetHash,
            fullRebuildValue: fullRebuild.datasetHash,
          },
          {
            field: 'recordCount',
            incrementalValue: incremental.recordCount,
            fullRebuildValue: fullRebuild.recordCount,
          },
        ];
      }

      return {
        projectionName,
        incrementalDigest: incremental,
        fullRebuildDigest: fullRebuild,
        isEquivalent,
        differences,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Verify a projection's integrity by comparing with expected digest
   */
  async verifyProjection(
    projectionName: string,
    blockRangeStart: bigint,
    blockRangeEnd: bigint,
    expectedHash: string,
  ): Promise<{ valid: boolean; actualHash: string; recordCount: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const records = await queryRunner.query(
        `SELECT * FROM "v2_projections" 
        WHERE "entity_type" = $1 AND "updated_at_block" BETWEEN $2 AND $3
        ORDER BY "entity_id"`,
        [projectionName, blockRangeStart, blockRangeEnd]
      );

      const normalizedRecords = this.normalizeRecords(records);
      const actualHash = this.computeDatasetHash(normalizedRecords);

      return {
        valid: actualHash === expectedHash,
        actualHash,
        recordCount: normalizedRecords.length,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get digest by ID
   */
  async getDigestById(queryRunner: QueryRunner, id: string): Promise<RebuildDigest | null> {
    const result = await queryRunner.query(
      `SELECT * FROM "v2_projection_digests" WHERE "id" = $1`,
      [id]
    );
    return result[0] ? this.mapToDigest(result[0]) : null;
  }

  /**
   * Get latest digest for a projection
   */
  async getLatestDigest(projectionName: string, rebuildType?: 'incremental' | 'full'): Promise<RebuildDigest | null> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      let query = `SELECT * FROM "v2_projection_digests" WHERE "projection_name" = $1`;
      const params: any[] = [projectionName];

      if (rebuildType) {
        query += ` AND "rebuild_type" = $2`;
        params.push(rebuildType);
      }

      query += ` ORDER BY "rebuilt_at" DESC LIMIT 1`;

      const result = await queryRunner.query(query, params);
      return result[0] ? this.mapToDigest(result[0]) : null;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get digest history for a projection
   */
  async getDigestHistory(projectionName: string, limit = 50): Promise<RebuildDigest[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(
        `SELECT * FROM "v2_projection_digests" 
        WHERE "projection_name" = $1 
        ORDER BY "rebuilt_at" DESC LIMIT $2`,
        [projectionName, limit]
      );
      return result.map(this.mapToDigest);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Run full rebuild and generate digest
   */
  async runFullRebuild(projectionName: string, projectorFn: () => Promise<void>): Promise<RebuildDigest> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const blockRangeStart = BigInt(0);
      const blockRangeEnd = BigInt(Number.MAX_SAFE_INTEGER);

      // Run the projector
      await projectorFn();

      // Generate digest
      const digest = await this.generateDigest(projectionName, queryRunner, {
        blockRangeStart,
        blockRangeEnd,
        rebuildType: 'full',
      });

      await queryRunner.commitTransaction();

      this.logger.log(`Full rebuild completed for ${projectionName}: ${digest.datasetHash.slice(0, 16)}...`);
      return digest;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Full rebuild failed for ${projectionName}: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Run incremental rebuild and generate digest
   */
  async runIncrementalRebuild(
    projectionName: string,
    projectorFn: () => Promise<void>,
    blockRangeStart: bigint,
    blockRangeEnd: bigint,
  ): Promise<RebuildDigest> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get previous digest for chaining
      const previousDigest = await this.getLatestDigest(projectionName, 'incremental');

      // Run the projector
      await projectorFn();

      // Generate digest
      const digest = await this.generateDigest(projectionName, queryRunner, {
        blockRangeStart,
        blockRangeEnd,
        rebuildType: 'incremental',
        previousDigestId: previousDigest?.id,
      });

      await queryRunner.commitTransaction();

      this.logger.log(`Incremental rebuild completed for ${projectionName}: ${digest.datasetHash.slice(0, 16)}...`);
      return digest;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Incremental rebuild failed for ${projectionName}: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Normalize records for deterministic hashing
   */
  private normalizeRecords(records: any[]): any[] {
    return records
      .map((record) => {
        // Remove volatile fields
        const { updated_at, integrity_hash: _integrityHash, ...normalized } = record;
        return normalized;
      })
      .sort((a, b) => {
        // Sort by entity_id for deterministic ordering
        const idA = String(a.entity_id || a.id || '');
        const idB = String(b.entity_id || b.id || '');
        return idA.localeCompare(idB);
      });
  }

  /**
   * Compute SHA-256 hash of normalized dataset
   */
  private computeDatasetHash(records: any[]): string {
    // Create canonical representation
    const canonical = records.map((r) => {
      // Ensure consistent key ordering
      const keys = Object.keys(r).sort();
      return keys.map((k) => `${k}:${JSON.stringify(r[k])}`).join('|');
    }).join('||');

    return createHash('sha256').update(canonical).digest('hex');
  }

  private mapToDigest(row: any): RebuildDigest {
    return {
      id: row.id,
      projectionName: row.projection_name,
      datasetHash: row.dataset_hash,
      recordCount: parseInt(row.record_count, 10),
      blockRangeStart: BigInt(row.block_range_start),
      blockRangeEnd: BigInt(row.block_range_end),
      rebuiltAt: new Date(row.rebuilt_at),
      rebuildType: row.rebuild_type,
      previousDigestId: row.previous_digest_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}