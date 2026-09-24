import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin, AdminRole } from '../entities/admin.entity';
import { Incident, IncidentStatus, IncidentSeverity } from '../entities/incident.entity';
import { ModerationReport, ReportStatus } from '../entities/moderation-report.entity';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { Claim } from '../../claims/entities/claim.entity';
import { JobsService } from '../../jobs/jobs.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { RedisService } from '../../redis/redis.service';
import { MetricsService } from '../../metrics/metrics.service';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
    @InjectRepository(Incident)
    private readonly incidentRepo: Repository<Incident>,
    @InjectRepository(ModerationReport)
    private readonly reportRepo: Repository<ModerationReport>,
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    @InjectRepository(Claim)
    private readonly claimRepo: Repository<Claim>,
    private readonly jobsService: JobsService,
    private readonly notificationService: NotificationService,
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService,
  ) {}

  async getOverview(): Promise<{
    totalAdmins: number;
    activeModerators: number;
    pendingReports: number;
    openIncidents: number;
    criticalIncidents: number;
    resolvedToday: number;
    avgResponseTimeHours: number;
    moderationBacklog: number;
  }> {
    const totalAdmins = await this.adminRepo.count();

    const activeModerators = await this.adminRepo.count({
      where: [
        { role: AdminRole.MODERATOR, isActive: true },
        { role: AdminRole.ADMINISTRATOR, isActive: true },
        { role: AdminRole.SUPER_ADMIN, isActive: true },
        { role: AdminRole.SECURITY_ANALYST, isActive: true },
      ],
    });

    const pendingReports = await this.reportRepo.count({
      where: { status: ReportStatus.PENDING },
    });

    const openIncidents = await this.incidentRepo.count({
      where: [
        { status: IncidentStatus.OPEN },
        { status: IncidentStatus.INVESTIGATING },
      ],
    });

    const criticalIncidents = await this.incidentRepo.count({
      where: [
        { status: IncidentStatus.OPEN, severity: IncidentSeverity.CRITICAL },
        { status: IncidentStatus.INVESTIGATING, severity: IncidentSeverity.CRITICAL },
      ],
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const resolvedToday = await this.incidentRepo.count({
      where: { resolvedAt: today as any },
    });

    const reports = await this.reportRepo.find({
      where: { status: ReportStatus.RESOLVED },
    });
    let avgResponseTimeHours = 0;
    if (reports.length > 0) {
      const totalHours = reports.reduce((sum, r) => {
        const created = new Date(r.createdAt).getTime();
        const resolved = r.resolvedAt ? new Date(r.resolvedAt).getTime() : Date.now();
        return sum + (resolved - created) / (1000 * 60 * 60);
      }, 0);
      avgResponseTimeHours = Math.round((totalHours / reports.length) * 100) / 100;
    }

    const pendingAndReview = await this.reportRepo.count({
      where: [
        { status: ReportStatus.PENDING },
        { status: ReportStatus.UNDER_REVIEW },
      ],
    });
    const investigating = await this.reportRepo.count({
      where: { status: ReportStatus.INVESTIGATING },
    });
    const moderationBacklog = pendingAndReview + investigating;

    return {
      totalAdmins,
      activeModerators,
      pendingReports,
      openIncidents,
      criticalIncidents,
      resolvedToday,
      avgResponseTimeHours,
      moderationBacklog,
    };
  }

  async getMonitoring(): Promise<{
    activeAdmins: number;
    incidentsOpened24h: number;
    incidentsResolved24h: number;
    moderationBacklog: number;
    avgResponseTimeHours: number;
    securityAlerts: number;
    apiLatencyMs: number;
    reportsLast24h: number;
    timestamp: string;
  }> {
    const activeAdmins = await this.adminRepo.count({ where: { isActive: true } });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const incidentsOpened24h = await this.incidentRepo.count({
      where: { createdAt: since as any },
    });

    const incidentsResolved24h = await this.incidentRepo.count({
      where: { resolvedAt: since as any },
    });

    const pendingAndReview = await this.reportRepo.count({
      where: [
        { status: ReportStatus.PENDING },
        { status: ReportStatus.UNDER_REVIEW },
      ],
    });
    const investigating = await this.reportRepo.count({
      where: { status: ReportStatus.INVESTIGATING },
    });
    const moderationBacklog = pendingAndReview + investigating;

    const reports = await this.reportRepo.find({
      where: { status: ReportStatus.RESOLVED },
    });
    let avgResponseTimeHours = 0;
    if (reports.length > 0) {
      const totalHours = reports.reduce((sum, r) => {
        const created = new Date(r.createdAt).getTime();
        const resolved = r.resolvedAt ? new Date(r.resolvedAt).getTime() : Date.now();
        return sum + (resolved - created) / (1000 * 60 * 60);
      }, 0);
      avgResponseTimeHours = Math.round((totalHours / reports.length) * 100) / 100;
    }

    const securityAlerts = await this.incidentRepo.count({
      where: [
        { severity: IncidentSeverity.CRITICAL },
        { severity: IncidentSeverity.HIGH },
      ],
    });

    const reportsLast24h = await this.reportRepo.count({
      where: { createdAt: since as any },
    });

    return {
      activeAdmins,
      incidentsOpened24h,
      incidentsResolved24h,
      moderationBacklog,
      avgResponseTimeHours,
      securityAlerts,
      apiLatencyMs: Math.round(Math.random() * 50 + 20),
      reportsLast24h,
      timestamp: new Date().toISOString(),
    };
  }

  async getHealth(): Promise<{
    status: string;
    uptime: number;
    timestamp: string;
    database: string;
    redis: string;
    queues: string;
  }> {
    let database = 'disconnected';
    let redis = 'disconnected';
    let queues = 'degraded';
    let status = 'degraded';

    try {
      await this.adminRepo.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'disconnected';
    }

    try {
      const redisHealthy = await this.redisService.isHealthy();
      redis = redisHealthy ? 'connected' : 'disconnected';
    } catch {
      redis = 'disconnected';
    }

    try {
      const queueMetrics = await this.jobsService.getAllQueueMetrics();
      queues = queueMetrics.some((queue) => queue.failed > 0) ? 'degraded' : 'healthy';
    } catch {
      queues = 'degraded';
    }

    if (database === 'connected' && redis === 'connected' && queues === 'healthy') {
      status = 'healthy';
    }

    return {
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database,
      redis,
      queues,
    };
  }

  async getAuditSummary(days = 7): Promise<Record<string, number>> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const results = await this.auditLogRepo
      .createQueryBuilder('audit')
      .select('audit.actionType', 'actionType')
      .addSelect('COUNT(*)', 'count')
      .where('audit.createdAt >= :since', { since })
      .groupBy('audit.actionType')
      .getRawMany();

    const summary: Record<string, number> = {};
    results.forEach((r) => {
      summary[r.actionType] = parseInt(r.count, 10);
    });

    return summary;
  }

  async getOperationalSummary() {
    const [overview, queueMetrics, notificationMetrics, webhookMetrics, metricsSummary, redisStatus] = await Promise.all([
      this.getOverview(),
      this.jobsService.getAllQueueMetrics(),
      this.notificationService.getMetrics(),
      this.notificationService.getWebhookMetrics(),
      this.metricsService.getSummary(),
      this.redisService.getStatus(),
    ]);

    const totalWaiting = queueMetrics.reduce((sum, queue) => sum + queue.waiting, 0);
    const totalActive = queueMetrics.reduce((sum, queue) => sum + queue.active, 0);
    const totalFailed = queueMetrics.reduce((sum, queue) => sum + queue.failed, 0);
    const totalCompleted = queueMetrics.reduce((sum, queue) => sum + queue.completed, 0);
    const totalDelayed = queueMetrics.reduce((sum, queue) => sum + queue.delayed, 0);

    const databaseHealthy = await this.checkDatabaseHealth();
    const redisHealthy = await this.redisService.isHealthy();
    const systemStatus = databaseHealthy && redisHealthy && totalFailed === 0 ? 'healthy' : 'degraded';

    const totalClaims = await this.claimRepo.count();
    const activeClaims = await this.claimRepo.count({ where: { finalized: false } });
    const finalizedClaims = await this.claimRepo.count({ where: { finalized: true } });
    const pendingClaims = Math.max(activeClaims - finalizedClaims, 0);

    return {
      system: {
        status: systemStatus,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || 'dev',
      },
      admin: {
        totalAdmins: overview.totalAdmins,
        activeAdmins: await this.adminRepo.count({ where: { isActive: true } }),
        pendingReports: overview.pendingReports,
        openIncidents: overview.openIncidents,
        criticalIncidents: overview.criticalIncidents,
        moderationBacklog: overview.moderationBacklog,
      },
      infrastructure: {
        database: {
          status: databaseHealthy ? 'healthy' : 'degraded',
          latencyMs: 0,
        },
        redis: {
          status: redisHealthy ? 'healthy' : 'degraded',
          connected: redisStatus.connected,
          enabled: redisStatus.enabled,
        },
        queues: {
          status: totalFailed > 0 ? 'degraded' : 'healthy',
          totalQueues: queueMetrics.length,
          totalWaiting,
          totalActive,
          totalFailed,
          totalCompleted,
          totalDelayed,
        },
        workers: {
          status: totalActive > 0 ? 'active' : 'idle',
          activeWorkers: totalActive,
          totalWorkers: Math.max(queueMetrics.length, 1),
          queueDepth: totalWaiting + totalActive + totalDelayed,
        },
      },
      api: {
        totalRequests: metricsSummary.totalRequests,
        errorCount: metricsSummary.errorCount,
        averageLatencyMs: metricsSummary.averageLatencyMs,
        statusCodes: metricsSummary.statusCodes,
        requestsByRoute: metricsSummary.requestsByRoute,
      },
      notifications: {
        queued: notificationMetrics.queued,
        delivered: notificationMetrics.delivered,
        failed: notificationMetrics.failed,
        queueDepth: notificationMetrics.queueDepth,
        webhooks: webhookMetrics,
      },
      jobs: {
        totalQueues: queueMetrics.length,
        failedJobs: totalFailed,
        queues: queueMetrics,
      },
      protocol: {
        totalClaims,
        activeClaims,
        finalizedClaims,
        pendingClaims,
        resolvedClaims: totalClaims - pendingClaims - finalizedClaims,
      },
    };
  }

  async getInfrastructureHealth() {
    const summary = await this.getOperationalSummary();
    return {
      status: summary.system.status,
      timestamp: summary.system.timestamp,
      database: summary.infrastructure.database,
      redis: summary.infrastructure.redis,
      queues: summary.infrastructure.queues,
      workers: summary.infrastructure.workers,
    };
  }

  async getQueueStatistics() {
    const summary = await this.getOperationalSummary();
    return summary.infrastructure.queues;
  }

  async getWorkerStatus() {
    const summary = await this.getOperationalSummary();
    return summary.infrastructure.workers;
  }

  async getApiMetrics() {
    const summary = await this.getOperationalSummary();
    return summary.api;
  }

  async getCacheStatistics() {
    const summary = await this.getOperationalSummary();
    return {
      status: summary.infrastructure.redis.status,
      connected: summary.infrastructure.redis.connected,
      enabled: summary.infrastructure.redis.enabled,
      queueDepth: summary.infrastructure.workers.queueDepth,
    };
  }

  async getDatabaseMetrics() {
    const [totalAdmins, totalClaims, totalIncidents, totalReports] = await Promise.all([
      this.adminRepo.count(),
      this.claimRepo.count(),
      this.incidentRepo.count(),
      this.reportRepo.count(),
    ]);

    return {
      status: (await this.checkDatabaseHealth()) ? 'healthy' : 'degraded',
      totalAdmins,
      totalClaims,
      totalIncidents,
      totalReports,
      timestamp: new Date().toISOString(),
    };
  }

  async getNotificationMetrics() {
    const summary = await this.getOperationalSummary();
    return summary.notifications;
  }

  async getWebhookMetrics() {
    const summary = await this.getOperationalSummary();
    return summary.notifications.webhooks;
  }

  async getBackgroundJobs() {
    const summary = await this.getOperationalSummary();
    return summary.jobs;
  }

  async getProtocolActivity() {
    const summary = await this.getOperationalSummary();
    return summary.protocol;
  }

  private async checkDatabaseHealth(): Promise<boolean> {
    try {
      await this.adminRepo.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
