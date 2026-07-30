import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { IpfsService } from '../ipfs/ipfs.service';
import { NotificationService } from '../notifications/services/notification.service';
import { JobsService } from '../jobs/jobs.service';
import { BlockchainStateService } from '../blockchain/state.service';
import {
  DependencyHealthResult,
  DependencyStatus,
  HealthCheckResult,
  HealthStatus,
  LivenessResult,
  ReadinessResult,
  StartupResult,
  SystemDiagnostics,
} from './health.types';

interface CheckConfig {
  name: string;
  critical: boolean;
  check: () => Promise<void>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();
  private readonly lastSuccess = new Map<string, string>();
  private appVersion: string;
  private readonly environment = process.env.NODE_ENV ?? 'development';
  private shuttingDown = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
    @InjectQueue('jobs-queue') private readonly jobsQueue: Queue,
    private readonly jobsService: JobsService,
    private readonly notificationService: NotificationService,
    private readonly ipfsService: IpfsService,
    private readonly blockchainStateService: BlockchainStateService,
  ) {
    this.appVersion = process.env.npm_package_version ?? '0.0.1';
  }

  getLiveness(): LivenessResult {
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
        ready: false,
        dependencies: [],
      };
    }

    const dependencies = await this.runChecks();
    const unhealthyCritical = dependencies.some((d) => d.status === 'unhealthy');
    const status = unhealthyCritical
      ? 'unhealthy'
      : dependencies.some((d) => d.status === 'degraded')
        ? 'degraded'
        : 'healthy';

    return {
      status,
      timestamp: new Date().toISOString(),
      ready: status !== 'unhealthy',
      dependencies,
    };
  }

  async getStartup(): Promise<StartupResult> {
    const dependencies = await this.runChecks();
    const status = this.aggregateStatus(dependencies);

    return {
      status,
      timestamp: new Date().toISOString(),
      ready: status !== 'unhealthy',
      startupComplete: !this.shuttingDown,
      dependencies,
    };
  }

  getDependencyHealth(): DependencyHealthResult {
    const dependencies = Array.from(this.lastSuccess.keys()).map((name) => ({
      name,
      status: 'healthy' as HealthStatus,
      responseTimeMs: 0,
      lastSuccessfulCheck: this.lastSuccess.get(name),
    }));

    return {
      status: this.aggregateStatus(dependencies),
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  async getHealth(): Promise<HealthCheckResult> {
    const dependencies = await this.runChecks();
    const diagnostics = this.collectDiagnostics();
    const services = this.aggregateServices(dependencies);
    const status = this.aggregateStatus(dependencies);

    return {
      status,
      timestamp: new Date().toISOString(),
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

  private async runChecks(): Promise<DependencyStatus[]> {
    const configs: CheckConfig[] = [
      {
        name: 'database',
        critical: true,
        check: () => this.checkDatabase(),
      },
      {
        name: 'redis',
        critical: false,
        check: () => this.checkRedis(),
      },
      {
        name: 'queue',
        critical: true,
        check: () => this.checkQueue(),
      },
      {
        name: 'notifications',
        critical: false,
        check: () => this.checkNotifications(),
      },
      {
        name: 'ipfs',
        critical: false,
        check: () => this.checkIpfs(),
      },
      {
        name: 'blockchain',
        critical: true,
        check: () => this.checkBlockchain(),
      },
    ];

    return Promise.all(
      configs.map(async (config) => {
        const start = Date.now();
        try {
          await config.check();
          const now = new Date().toISOString();
          this.lastSuccess.set(config.name, now);
          return {
            name: config.name,
            status: 'healthy' as HealthStatus,
            responseTimeMs: Date.now() - start,
            lastSuccessfulCheck: this.lastSuccess.get(config.name),
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Health check failed for ${config.name}: ${reason}`);
          return {
            name: config.name,
            status: config.critical ? 'unhealthy' : 'degraded',
            responseTimeMs: Date.now() - start,
            lastSuccessfulCheck: this.lastSuccess.get(config.name),
            failureReason: reason,
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
    await this.jobsQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  }

  private async checkNotifications(): Promise<void> {
    const metrics = await this.notificationService.getMetrics();
    if (metrics.queueDepth > 1000) {
      throw new Error('Notification queue depth exceeds threshold');
    }
  }

  private async checkIpfs(): Promise<void> {
    const cid = await this.ipfsService.uploadBuffer(Buffer.from('health-check'), 'health-check.txt');
    if (!cid?.cid) {
      throw new Error('IPFS provider did not return a valid CID');
    }
  }

  private async checkBlockchain(): Promise<void> {
    const state = await this.blockchainStateService.getChainState();
    if (typeof state.lastProcessedBlock !== 'number') {
      throw new Error('Blockchain state is unavailable');
    }
  }

  private aggregateServices(dependencies: DependencyStatus[]): Record<string, HealthStatus> {
    return dependencies.reduce((acc, dep) => {
      acc[dep.name] = dep.status;
      return acc;
    }, {} as Record<string, HealthStatus>);
  }

  private aggregateStatus(dependencies: DependencyStatus[]): HealthStatus {
    if (dependencies.some((d) => d.status === 'unhealthy')) return 'unhealthy';
    if (dependencies.some((d) => d.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private collectDiagnostics(): SystemDiagnostics {
    return {
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      resourceUsage: process.resourceUsage(),
    };
  }

  private buildSummary(dependencies: DependencyStatus[]): {
    healthy: number;
    degraded: number;
    unhealthy: number;
    total: number;
  } {
    const healthy = dependencies.filter((d) => d.status === 'healthy').length;
    const degraded = dependencies.filter((d) => d.status === 'degraded').length;
    const unhealthy = dependencies.filter((d) => d.status === 'unhealthy').length;
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
