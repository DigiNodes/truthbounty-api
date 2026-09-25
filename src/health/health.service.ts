import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { IpfsService } from '../ipfs/ipfs.service';
import { NotificationService } from '../notifications/services/notification.service';
import { JobsService } from '../jobs/jobs.service';
import { BlockchainStateService } from '../blockchain/state.service';
import { MetricsService } from '../metrics/metrics.service';
import { classifyFailure, withTimeout } from './utils/bounded-probe.util';
import {
  DependencyHealthResult,
  DependencyStatus,
  HealthCheckResult,
  HealthStatus,
  IndexerHealthResult,
  LivenessResult,
  ReadinessResult,
  StartupResult,
  SystemDiagnostics,
} from './health.types';

interface CheckConfig {
  name: string;
  critical: boolean;
  timeoutMs: number;
  check: () => Promise<void>;
}

/**
 * How long a completed dependency-check pass may be reused for. Readiness is
 * called frequently by orchestrators/load balancers; without a bound here
 * every public hit would fan out to every subsystem (including a real IPFS
 * write). The cache is short enough that "ready" can never mask an outage
 * for longer than this window, and every response reports `checkedAt` so
 * callers can see they received a cached measurement rather than a live one.
 */
const CHECK_CACHE_TTL_MS = 3000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();
  private readonly lastSuccess = new Map<string, string>();
  private appVersion: string;
  private readonly environment = process.env.NODE_ENV ?? 'development';
  private shuttingDown = false;

  private cachedChecks: { checkedAt: number; result: DependencyStatus[] } | null = null;
  private inFlightChecks: Promise<DependencyStatus[]> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
    @InjectQueue('jobs-queue') private readonly jobsQueue: Queue,
    private readonly jobsService: JobsService,
    private readonly notificationService: NotificationService,
    private readonly ipfsService: IpfsService,
    private readonly blockchainStateService: BlockchainStateService,
    private readonly metricsService: MetricsService,
  ) {
    this.appVersion = process.env.npm_package_version ?? '0.0.1';
  }

  getLiveness(): LivenessResult {
    // Liveness must never touch a dependency: it answers "is the process
    // alive", not "can it serve traffic". Mixing the two makes a slow
    // downstream dependency trigger process restarts instead of just
    // pulling the pod out of rotation via readiness.
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: this.getUptime(),
    };
  }

  async getReadiness(): Promise<ReadinessResult> {
    if (this.shuttingDown) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        ready: false,
        dependencies: [],
      };
    }

    const { dependencies, checkedAt } = await this.getChecks();
    const status = this.aggregateStatus(dependencies);

    return {
      status,
      timestamp: new Date().toISOString(),
      checkedAt: new Date(checkedAt).toISOString(),
      ready: status !== 'unhealthy',
      dependencies,
    };
  }

  async getStartup(): Promise<StartupResult> {
    const { dependencies, checkedAt } = await this.getChecks();
    const status = this.aggregateStatus(dependencies);

    return {
      status,
      timestamp: new Date().toISOString(),
      checkedAt: new Date(checkedAt).toISOString(),
      ready: status !== 'unhealthy',
      startupComplete: !this.shuttingDown,
      dependencies,
    };
  }

  async getDependencyHealth(): Promise<DependencyHealthResult> {
    // Previously this synthesized results from a name list with a hardcoded
    // 0ms response time and an unconditional 'healthy' status, regardless of
    // whether the dependency was actually reachable. That's the exact
    // fabricated-optimism failure mode this endpoint exists to prevent, so
    // it now shares the same bounded, cached probe pass as readiness.
    const { dependencies, checkedAt } = await this.getChecks();

    return {
      status: this.aggregateStatus(dependencies),
      timestamp: new Date().toISOString(),
      checkedAt: new Date(checkedAt).toISOString(),
      dependencies,
    };
  }

  /**
   * Sanitized indexer health report. Exposes observed head, safe/finalized
   * cursors, projection lag, RPC failures, replay count, and dead letters
   * without leaking credentials, user data, or live RPC URLs.
   */
  async getIndexerHealth(): Promise<IndexerHealthResult> {
    const snapshot = await this.blockchainStateService.getIndexerHealth();
    const status = snapshot.status as HealthStatus;
    return {
      status,
      timestamp: new Date().toISOString(),
      snapshot,
    };
  }

  async getHealth(): Promise<HealthCheckResult> {
    const { dependencies, checkedAt } = await this.getChecks();
    const diagnostics = await this.collectDiagnostics();
    const services = this.aggregateServices(dependencies);
    const status = this.aggregateStatus(dependencies);

    return {
      status,
      timestamp: new Date().toISOString(),
      checkedAt: new Date(checkedAt).toISOString(),
      version: this.appVersion,
      environment: this.environment,
      uptime: this.getUptime(),
      summary: this.buildSummary(dependencies),
      services,
      dependencies,
      diagnostics,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
  }

  /**
   * Returns a recent bounded dependency-check pass, reusing an in-flight or
   * recently-completed pass instead of re-querying every subsystem on every
   * call. Concurrent callers within the same tick share one in-flight
   * check (dedupe); callers within `CHECK_CACHE_TTL_MS` of the last
   * completed pass reuse its result.
   */
  private async getChecks(): Promise<{ dependencies: DependencyStatus[]; checkedAt: number }> {
    const now = Date.now();
    if (this.cachedChecks && now - this.cachedChecks.checkedAt < CHECK_CACHE_TTL_MS) {
      return { dependencies: this.cachedChecks.result, checkedAt: this.cachedChecks.checkedAt };
    }

    if (!this.inFlightChecks) {
      this.inFlightChecks = this.runChecks().finally(() => {
        this.inFlightChecks = null;
      });
    }

    const dependencies = await this.inFlightChecks;
    const checkedAt = Date.now();
    this.cachedChecks = { checkedAt, result: dependencies };
    return { dependencies, checkedAt };
  }

  private async runChecks(): Promise<DependencyStatus[]> {
    const configs: CheckConfig[] = [
      {
        name: 'database',
        critical: true,
        timeoutMs: 2000,
        check: () => this.checkDatabase(),
      },
      {
        name: 'redis',
        critical: false,
        timeoutMs: 1000,
        check: () => this.checkRedis(),
      },
      {
        name: 'queue',
        critical: true,
        timeoutMs: 2000,
        check: () => this.checkQueue(),
      },
      {
        name: 'notifications',
        critical: false,
        timeoutMs: 1500,
        check: () => this.checkNotifications(),
      },
      {
        name: 'ipfs',
        critical: false,
        timeoutMs: 3000,
        check: () => this.checkIpfs(),
      },
      {
        name: 'blockchain',
        critical: true,
        timeoutMs: 2000,
        check: () => this.checkBlockchain(),
      },
    ];

    return Promise.all(
      configs.map(async (config) => {
        const start = Date.now();
        try {
          await withTimeout(config.name, config.timeoutMs, config.check);
          const now = new Date().toISOString();
          this.lastSuccess.set(config.name, now);
          return {
            name: config.name,
            status: 'healthy' as HealthStatus,
            critical: config.critical,
            responseTimeMs: Date.now() - start,
            lastSuccessfulCheck: this.lastSuccess.get(config.name),
          };
        } catch (error) {
          const { reason, reasonCode } = classifyFailure(error);
          this.logger.warn(`Health check failed for ${config.name} [${reasonCode}]: ${reason}`);
          return {
            name: config.name,
            // Fail closed: any probe that errors or times out is treated as
            // unhealthy for critical dependencies, degraded otherwise. There
            // is no "assume healthy" fallback path.
            status: config.critical ? 'unhealthy' : 'degraded',
            critical: config.critical,
            responseTimeMs: Date.now() - start,
            lastSuccessfulCheck: this.lastSuccess.get(config.name),
            failureReason: reason,
            failureReasonCode: reasonCode,
          };
        }
      }),
    );
  }

  private async checkDatabase(): Promise<void> {
    if (!this.dataSource.isInitialized) {
      throw new Error('Database connection not initialized');
    }
    await this.dataSource.query('SELECT 1');
  }

  private async checkRedis(): Promise<void> {
    const healthy = await this.redisService.isHealthy();
    if (!healthy) {
      throw new Error('Redis is not healthy');
    }
  }

  private async checkQueue(): Promise<void> {
    const counts = await this.jobsQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    this.metricsService.setQueueDepth(this.jobsQueue.name, counts);
  }

  private async checkNotifications(): Promise<void> {
    const metrics = await this.notificationService.getMetrics();
    if (metrics.queueDepth > 1000) {
      throw new Error('Notification queue depth exceeds threshold');
    }
  }

  private async checkIpfs(): Promise<void> {
    const cid = await this.ipfsService.uploadBuffer(
      Buffer.from('health-check'),
      'health-check.txt',
    );
    if (!cid?.cid) {
      throw new Error('IPFS provider did not return a valid CID');
    }
  }

  private async checkBlockchain(): Promise<void> {
    const state = await this.blockchainStateService.getChainState();
    if (typeof state.lastProcessedBlock !== 'number') {
      throw new Error('Blockchain state is unavailable');
    }
    this.metricsService.setBlockchainIndexingState(state.lastProcessedBlock);

    // Fail closed if the indexer is degraded per alert thresholds
    // (projection lag, RPC failure rate, dead-letter count) or has never
    // observed a head/finalized cursor.
    const health = await this.blockchainStateService.getIndexerHealth();
    if (health.status === 'unhealthy') {
      throw new Error('Indexer health is unavailable: missing head/finality cursors');
    }
    if (health.status === 'degraded') {
      throw new Error('Indexer health is degraded beyond alert thresholds');
    }
  }

  private aggregateServices(
    dependencies: DependencyStatus[],
  ): Record<string, HealthStatus> {
    return dependencies.reduce(
      (acc, dep) => {
        acc[dep.name] = dep.status;
        return acc;
      },
      {} as Record<string, HealthStatus>,
    );
  }

  private aggregateStatus(dependencies: DependencyStatus[]): HealthStatus {
    if (dependencies.some((d) => d.status === 'unhealthy')) return 'unhealthy';
    if (dependencies.some((d) => d.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private async collectDiagnostics(): Promise<SystemDiagnostics> {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    this.metricsService.setMemoryUsage(memoryUsage);
    this.metricsService.setCpuUsage(cpuUsage);

    const diagnostics: SystemDiagnostics = {
      memoryUsage,
      cpuUsage,
      resourceUsage: process.resourceUsage(),
    };

    // Add database diagnostics
    try {
      const start = Date.now();
      await withTimeout('database-diagnostics', 2000, () =>
        this.dataSource.query('SELECT 1'),
      );
      const latencyMs = Date.now() - start;

      const appliedMigrations = await withTimeout(
        'database-migrations',
        2000,
        () => this.dataSource.query('SELECT COUNT(*) as count FROM migrations'),
      );
      const totalMigrations = this.dataSource.migrations.length;
      const pool = (this.dataSource.driver as any).master;

      diagnostics.database = {
        connectivity: true,
        latencyMs,
        migrationsApplied: Number(appliedMigrations[0]?.count ?? 0),
        migrationsPending: Math.max(
          0,
          totalMigrations - Number(appliedMigrations[0]?.count ?? 0),
        ),
        poolTotal: pool?.totalCount ?? 0,
        poolIdle: pool?.idleCount ?? 0,
        poolActive: pool?.totalCount
          ? pool.totalCount - (pool.idleCount ?? 0)
          : 0,
        poolWaiting: pool?.waitingCount ?? 0,
      };
    } catch {
      diagnostics.database = {
        connectivity: false,
        latencyMs: 0,
        migrationsApplied: 0,
        migrationsPending: 0,
        poolTotal: 0,
        poolIdle: 0,
        poolActive: 0,
        poolWaiting: 0,
      };
    }

    return diagnostics;
  }

  private buildSummary(dependencies: DependencyStatus[]): {
    healthy: number;
    degraded: number;
    unhealthy: number;
    total: number;
  } {
    const healthy = dependencies.filter((d) => d.status === 'healthy').length;
    const degraded = dependencies.filter((d) => d.status === 'degraded').length;
    const unhealthy = dependencies.filter(
      (d) => d.status === 'unhealthy',
    ).length;
    return {
      healthy,
      degraded,
      unhealthy,
      total: dependencies.length,
    };
  }

  private getUptime(): number {
    return Date.now() - this.startTime;
  }
}
