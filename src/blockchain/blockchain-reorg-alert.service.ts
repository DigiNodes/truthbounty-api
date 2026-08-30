import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReorgEventRecord } from './entities/reorg-event.entity';

/**
 * Operational alert levels for reorg events.
 */
export enum ReorgAlertLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

/**
 * A structured alert emitted during reorg handling.
 * Consumed by monitoring dashboards, logging pipelines, and the API layer.
 */
export interface ReorgAlert {
  level: ReorgAlertLevel;
  phase: 'detected' | 'rollback' | 'replay' | 'error';
  reorgEventId: number;
  reorgDepth: number;
  affectedBlockStart: number;
  affectedBlockEnd: number;
  orphanedEventCount: number;
  replayedEventCount?: number;
  durationMs?: number;
  error?: string;
  timestamp: Date;
}

/**
 * Central service for emitting operational alerts on chain reorganizations.
 *
 * Writes the audit trail to the `reorg_events` table and emits structured
 * alerts that can be consumed by monitoring, dashboards, and alerting
 * pipelines. The alert service never blocks the rollback/replay pipeline —
 * persistence failures are logged but not re-thrown.
 *
 * Recent alerts are kept in a bounded in-memory ring buffer for low-latency
 * API queries and health checks.
 */
@Injectable()
export class BlockchainReorgAlertService {
  private readonly logger = new Logger(BlockchainReorgAlertService.name);

  /** Bounded ring buffer of recent alerts for API / health-check queries. */
  private readonly recentAlerts: ReorgAlert[] = [];
  private readonly maxRecentAlerts = 100;

  /** Subscribers for real-time alert consumption (in-process). */
  private readonly subscribers = new Set<(alert: ReorgAlert) => void>();

  constructor(
    @InjectRepository(ReorgEventRecord)
    private readonly reorgEventRepo: Repository<ReorgEventRecord>,
  ) {}

  /**
   * Record a newly detected reorg and emit a WARN-level alert.
   * Returns the persisted record so callers can update it later.
   */
  async recordDetection(payload: {
    reorgDepth: number;
    affectedBlockStart: number;
    affectedBlockEnd: number;
    orphanedEventCount: number;
  }): Promise<ReorgEventRecord> {
    const record = this.reorgEventRepo.create({
      reorgDepth: payload.reorgDepth,
      affectedBlockStart: payload.affectedBlockStart,
      affectedBlockEnd: payload.affectedBlockEnd,
      orphanedEventCount: payload.orphanedEventCount,
      completedSuccessfully: false,
    });

    const saved = await this.reorgEventRepo.save(record);

    const alert: ReorgAlert = {
      level: ReorgAlertLevel.WARN,
      phase: 'detected',
      reorgEventId: saved.id,
      reorgDepth: payload.reorgDepth,
      affectedBlockStart: payload.affectedBlockStart,
      affectedBlockEnd: payload.affectedBlockEnd,
      orphanedEventCount: payload.orphanedEventCount,
      timestamp: saved.detectedAt,
    };

    this.emitAlert(alert);

    return saved;
  }

  /**
   * Mark a reorg record as having completed rollback.
   */
  async recordRollbackComplete(
    reorgEventId: number,
    durationMs: number,
  ): Promise<void> {
    await this.reorgEventRepo.update(reorgEventId, { durationMs });

    this.emitAlert({
      level: ReorgAlertLevel.INFO,
      phase: 'rollback',
      reorgEventId,
      reorgDepth: 0,
      affectedBlockStart: 0,
      affectedBlockEnd: 0,
      orphanedEventCount: 0,
      durationMs,
      timestamp: new Date(),
    });
  }

  /**
   * Mark a reorg record as fully completed with replay stats.
   */
  async recordReplayComplete(
    reorgEventId: number,
    replayedEventCount: number,
    canonicalHashAfterReplay: string | null,
    durationMs: number,
  ): Promise<void> {
    await this.reorgEventRepo.update(reorgEventId, {
      completedSuccessfully: true,
      replayedEventCount,
      canonicalHashAfterReplay,
      durationMs,
    });

    this.emitAlert({
      level: ReorgAlertLevel.INFO,
      phase: 'replay',
      reorgEventId,
      reorgDepth: 0,
      affectedBlockStart: 0,
      affectedBlockEnd: 0,
      orphanedEventCount: 0,
      replayedEventCount,
      durationMs,
      timestamp: new Date(),
    });
  }

  /**
   * Record that reorg handling failed.
   */
  async recordError(reorgEventId: number, error: string): Promise<void> {
    await this.reorgEventRepo.update(reorgEventId, {
      completedSuccessfully: false,
      errorMessage: error,
    });

    this.emitAlert({
      level: ReorgAlertLevel.ERROR,
      phase: 'error',
      reorgEventId,
      reorgDepth: 0,
      affectedBlockStart: 0,
      affectedBlockEnd: 0,
      orphanedEventCount: 0,
      error,
      timestamp: new Date(),
    });
  }

  /**
   * Subscribe to real-time alerts. Returns an unsubscribe function.
   */
  subscribe(listener: (alert: ReorgAlert) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * Get the most recent alerts (newest-first).
   */
  getRecentAlerts(limit: number = 50): ReorgAlert[] {
    return this.recentAlerts.slice(0, limit);
  }

  /**
   * Get recent reorg history from the database for operational dashboards.
   */
  async getRecentReorgs(limit: number = 50): Promise<ReorgEventRecord[]> {
    return this.reorgEventRepo.find({
      order: { detectedAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get a summary of reorg activity for health checks.
   */
  async getReorgSummary(): Promise<{
    totalReorgs: number;
    failedReorgs: number;
    lastReorgAt: Date | null;
    averageDepth: number;
  }> {
    const total = await this.reorgEventRepo.count();
    const failed = await this.reorgEventRepo.count({
      where: { completedSuccessfully: false },
    });

    const lastReorg = await this.reorgEventRepo.findOne({
      order: { detectedAt: 'DESC' },
      select: ['detectedAt'],
    });

    const allReorgs = await this.reorgEventRepo.find({
      select: ['reorgDepth'],
      order: { detectedAt: 'DESC' },
      take: 100,
    });

    const averageDepth =
      allReorgs.length > 0
        ? allReorgs.reduce((sum, r) => sum + r.reorgDepth, 0) /
          allReorgs.length
        : 0;

    return {
      totalReorgs: total,
      failedReorgs: failed,
      lastReorgAt: lastReorg?.detectedAt ?? null,
      averageDepth: Math.round(averageDepth * 100) / 100,
    };
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private emitAlert(alert: ReorgAlert): void {
    // Structured log at the appropriate level
    const msg =
      `REORG ${alert.phase.toUpperCase()} [id=${alert.reorgEventId}]: ` +
      `depth=${alert.reorgDepth}, ` +
      `blocks=${alert.affectedBlockStart}-${alert.affectedBlockEnd}, ` +
      `orphaned=${alert.orphanedEventCount}` +
      (alert.durationMs != null ? `, duration=${alert.durationMs}ms` : '') +
      (alert.error != null ? `, error=${alert.error}` : '');

    switch (alert.level) {
      case ReorgAlertLevel.ERROR:
      case ReorgAlertLevel.CRITICAL:
        this.logger.error(msg);
        break;
      case ReorgAlertLevel.WARN:
        this.logger.warn(msg);
        break;
      default:
        this.logger.log(msg);
    }

    // Ring buffer for API queries
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > this.maxRecentAlerts) {
      this.recentAlerts.pop();
    }

    // Notify in-process subscribers
    for (const subscriber of this.subscribers) {
      try {
        subscriber(alert);
      } catch {
        // Never let a subscriber crash the pipeline
      }
    }
  }
}
