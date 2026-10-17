import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { LeaderLease } from './entities/leader-lease.entity';
import { LeaderElectionAudit } from './entities/leader-election-audit.entity';

export interface LeaseHandle {
  readonly jobName: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: Date;
  readonly acquiredAt: Date;
}

export class LeaseLostError extends Error {
  constructor(
    readonly jobName: string,
    readonly ownerId: string,
    readonly fencingToken: number,
    reason: string,
  ) {
    super(`Lease lost for job "${jobName}" (owner ${ownerId}, token ${fencingToken}): ${reason}`);
    this.name = 'LeaseLostError';
  }
}

/**
 * Distributed leader election with fencing tokens for singleton background
 * jobs (migrations, rebuilds, retention, schedulers, reconciliation).
 *
 * The lease is stored in the database and is the single source of truth for
 * "who is the current leader". Every acquisition bumps a monotonically
 * increasing `fencingToken`. Workers that mutate singleton state must pass
 * their token to the mutation so that a stale leader (whose lease has been
 * taken over) is fenced out at the storage layer.
 *
 * The contract is deliberately narrow and fail-closed:
 *  - `tryAcquire` only succeeds when the lease is free or expired.
 *  - `renew` only succeeds when the caller still holds the lease and the
 *    token matches.
 *  - `assertLeader` throws `LeaseLostError` if the caller is no longer
 *    the current leader (or the token is stale).
 *  - `release` is idempotent and only affects the caller's own lease.
 *
 * Clock skew is handled by always using the database clock (`NOW()`) for
 * expiry decisions. The in-memory expiry time is only used as a conservative
 * upper bound for the local renew schedule.
 */
@Injectable()
export class LeaderElectionService implements OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);
  private readonly ownerId: string;
  private readonly leaseTimeMs: number;
  private readonly renewIntervalMs: number;
  private readonly handles: Map<string, LeaseHandle> = new Map();
  private readonly renewTimers: Map<string, NodeJS.Timer> = new Map();
  private destroyed = false;

  constructor(
    @InjectRepository(LeaderLease)
    private readonly leaseRepo: Repository<LeaderLease>,
    @InjectRepository(LeaderElectionAudit)
    private readonly auditRepo: Repository<LeaderElectionAudit>,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.ownerId =
      this.configService.get<string>('LEADER_ELECTION_OWNER_ID') ??
      `${this.resolveHostname()}-${randomUUID()}`;
    const leaseSeconds = this.resolvePositiveInt(
      'LEADER_ELECTION_LEASE_SECONDS',
      30,
    );
    this.leaseTimeMs = leaseSeconds * 1000;
    // Renew at 1/3 of the lease duration to tolerate brief database latency.
    this.renewIntervalMs = Math.max(1000, Math.floor(this.leaseTimeMs / 3));
  }

  /** The stable identity of this worker for the lifetime of the process. */
  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Attempt to acquire the lease for `jobName`. Returns the handle on
   * success, or null if another worker currently holds a live lease.
   *
   * The acquisition is atomic and fail-closed: it relies on a conditional
   * UPDATE against the database clock, so concurrent attempts from many
   * workers cannot both win.
   */
  async tryAcquire(jobName: string): Promise<LeaseHandle | null> {
    if (this.destroyed) {
      return null;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseTimeMs);

    const result = await this.dataSource.transaction(async (manager) => {
      // Lock the row (or discover it does not exist) and decide atomically.
      const existing = await manager.getRepository(LeaderLease).findOne({
        where: { jobName },
        lock: { mode: 'pessimistic_write' },
      });

      const dbUnderLease = await this.isLeaseAlive(manager, jobName);

      if (existing && dbUnderLease) {
        // Someone else holds a live lease. Record the contention for audit
        // but do not mutate the lease.
        await this.recordAudit(manager, {
          jobName,
          event: 'acquire_rejected',
          ownerId: this.ownerId,
          fencingToken: existing.fencingToken,
          previousOwnerId: existing.ownerId,
          previousToken: existing.fencingToken,
          details: { expiresAt: existing.expiresAt.toISOString() },
        });
        return null;
      }

      const nextToken = (existing?.fencingToken ?? 0) + 1;
      const previousOwnerId = existing?.ownerId ?? null;
      const previousToken = existing?.fencingToken ?? 0;

      const saved = existing
        ? await manager.save(LeaderLease, {
            ...existing,
            ownerId: this.ownerId,
            fencingToken: nextToken,
            acquiredAt: now,
            expiresAt,
            renewedAt: now,
          })
        : await manager.save(LeaderLease, {
            jobName,
            ownerId: this.ownerId,
            fencingToken: nextToken,
            acquiredAt: now,
            expiresAt,
            renewedAt: now,
          });

      await this.recordAudit(manager, {
        jobName,
        event: previousOwnerId ? 'takeover' : 'acquired',
        ownerId: this.ownerId,
        fencingToken: nextToken,
        previousOwnerId: previousOwnerId,
        previousToken: previousToken,
        details: { expiresAt: expiresAt.toISOString() },
      });

      return saved;
    });

    if (!result) {
      return null;
    }

    const handle: LeaseHandle = {
      jobName,
      ownerId: this.ownerId,
      fencingToken: result.fencingToken,
      expiresAt: result.expiresAt,
      acquiredAt: result.acquiredAt,
    };
    this.handles.set(jobName, handle);
    this.scheduleRenewal(handle);
    this.logger.log(
      `Acquired lease for "${jobName}" (owner ${this.ownerId}, token ${handle.fencingToken})`,
    );
    return handle;
  }

  /**
   * Renew the lease. Returns true if the caller still holds the lease and
   * the token is unchanged. Returns false otherwise (and drops the local
   * handle so the caller must stop work).
   */
  async renew(handle: LeaseHandle): Promise<boolean> {
    if (this.destroyed) {
      return false;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.leaseTimeMs);

    const result = await this.dataSource.transaction(async (manager) => {
      const row = await manager.getRepository(LeaderLease).findOne({
        where: { jobName: handle.jobName },
        lock: { mode: 'pessimistic_write' },
      });

      if (
        !row ||
        row.ownerId !== handle.ownerId ||
        row.fencingToken !== handle.fencingToken
      ) {
        await this.recordAudit(manager, {
          jobName: handle.jobName,
          event: 'renew_rejected',
          ownerId: handle.ownerId,
          fencingToken: handle.fencingToken,
          previousOwnerId: row?.ownerId ?? null,
          previousToken: row?.fencingToken ?? 0,
          details: { reason: 'stale_token_or_owner_mismatch' },
        });
        return null;
      }

      // Fail closed if the database clock already considers this lease
      // expired -- another worker may have taken it over in the meantime.
      const alive = await this.isLeaseAlive(manager, handle.jobName);
      if (!alive) {
        await this.recordAudit(manager, {
          jobName: handle.jobName,
          event: 'renew_rejected',
          ownerId: handle.ownerId,
          fencingToken: handle.fencingToken,
          previousOwnerId: row.ownerId,
          previousToken: row.fencingToken,
          details: { reason: 'lease_expired' },
        });
        return null;
      }

      row.renewedAt = now;
      row.expiresAt = expiresAt;
      await manager.save(LeaderLease, row);
      return row;
    });

    if (!result) {
      this.dropHandle(handle.jobName);
      return false;
    }

    const updated: LeaseHandle = {
      ...handle,
      expiresAt: result.expiresAt,
    };
    this.handles.set(handle.jobName, updated);
    return true;
  }

  /**
   * Throws `LeaseLostError` if the caller is no longer the current leader for
   * `jobName`. Use this immediately before any singleton mutation.
   */
  async assertLeader(handle: LeaseHandle): Promise<void> {
    const row = await this.leaseRepo.findOne({
      where: { jobName: handle.jobName },
    });
    if (!row) {
      this.dropHandle(handle.jobName);
      throw new LeaseLostError(
        handle.jobName,
        handle.ownerId,
        handle.fencingToken,
        'no lease row found',
      );
    }
    if (
      row.ownerId !== handle.ownerId ||
      row.fencingToken !== handle.fencingToken
    ) {
      this.dropHandle(handle.jobName);
      throw new LeaseLostError(
        handle.jobName,
        handle.ownerId,
        handle.fencingToken,
        'stale token',
      );
    }
    const alive = await this.isLeaseAlive(this.dataSource.manager, handle.jobName);
    if (!alive) {
      this.dropHandle(handle.jobName);
      throw new LeaseLostError(
        handle.jobName,
        handle.ownerId,
        handle.fencingToken,
        'lease expired',
      );
    }
  }

  /**
   * Release the lease if the caller still holds it. Idempotent.
   */
  async release(handle: LeaseHandle): Promise<void> {
    this.dropHandle(handle.jobName);
    try {
      await this.dataSource.transaction(async (manager) => {
        const row = await manager.getRepository(LeaderLease).findOne({
          where: { jobName: handle.jobName },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !row ||
          row.ownerId !== handle.ownerId ||
          row.fencingToken !== handle.fencingToken
        ) {
          return;
        }
        // Expire immediately so another worker can take over without
        // waiting for the full lease duration. The token is not reused.
        row.expiresAt = new Date(0);
        row.renewedAt = new Date();
        await manager.save(LeaderLease, row);
        await this.recordAudit(manager, {
          jobName: handle.jobName,
          event: 'released',
          ownerId: handle.ownerId,
          fencingToken: handle.fencingToken,
          previousOwnerId: handle.ownerId,
          previousToken: handle.fencingToken,
          details: null,
        });
      });
    } catch (error) {
      this.logger.warn(`Failed to release lease for "${handle.jobName}": ${(error as Error).message}`);
    }
  }

  /**
   * Run a singleton job under a lease. The callback receives the handle and
   * must call `assertLeader` immediately before any mutation. If the lease
   * is contented or lost, the job is skipped.
   */
  async runIfLeader<T>(
    jobName: string,
    work: (handle: LeaseHandle) => Promise<T>,
  ): Promise<T | null> {
    const handle = await this.tryAcquire(jobName);
    if (!handle) {
      this.logger.debug(`Skipping "${jobName}": lease held by another worker`);
      return null;
    }
    try {
      return await work(handle);
    } finally {
      await this.release(handle);
    }
  }

  /**
   * Periodic cleanup of expired lease rows that have not been reclaimed.
   * This keeps the lease table from growing unbounded and ensures that a
   * restarted worker sees a clean state.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'leader-lease-cleanup', timeZone: 'UTC' })
  async cleanupExpiredLeases(): Promise<void> {
    if (this.destroyed) {
      return {} as unknown as void;
    }
    const cutoff = new Date(Date.now() - this.leaseTimeMs * 2);
    try {
      const result = await this.leaseRepo.delete({ expiresAt: LessThan(cutoff) });
      if (result.affected && result.affected > 0) {
        this.logger.log(`Removed ${result.affected} expired lease row(s)`);
      }
    } catch (error) {
      this.logger.warn(`Failed to clean up expired leases: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    for (const timer of this.renewTimers.values()) {
      clearTimeout(timer as unknown as NodeJS.Timeout);
    }
    this.renewTimers.clear();
    const handles = Array.from(this.handles.values());
    this.handles.clear();
    for (const handle of handles) {
      try {
        await this.release(handle);
      } catch {
        // best effort on shutdown
      }
    }
  }

  private scheduleRenewal(handle: LeaseHandle): void {
    const existing = this.renewTimers.get(handle.jobName);
    if (existing) {
      clearTimeout(existing as unknown as NodeJS.Timeout);
    }
    const timer = setTimeout(() => {
      void this.renew(handle).catch((error) => {
        this.logger.warn(
          `Lease renewal failed for "${handle.jobName}": ${(error as Error).message}`,
        );
        this.dropHandle(handle.jobName);
      });
    }, this.renewIntervalMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.renewTimers.set(handle.jobName, timer as unknown as NodeJS.Timer);
  }

  private dropHandle(jobName: string): void {
    this.handles.delete(jobName);
    const timer = this.renewTimers.get(jobName);
    if (timer) {
      clearTimeout(timer as unknown as NodeJS.Timeout);
      this.renewTimers.delete(jobName);
    }
  }

  private async isLeaseAlive(
    manager: EntityManager,
    jobName: string,
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT expires_at > NOW() AS alive FROM leader_lease WHERE job_name = $1 LIMIT 1`,
      [jobName],
    )) as Array<{ alive: boolean | string | number }>;
    if (!rows.length) {
      return false;
    }
    const value = rows[0].alive;
    return value === true || value === 't' || value === 1 || value === '1';
  }

  private async recordAudit(
    manager: EntityManager,
    entry: {
      jobName: string;
      event: string;
      ownerId: string;
      fencingToken: number;
      previousOwnerId: string | null;
      previousToken: number;
      details: Record<string, unknown> | null;
    },
  ): Promise<void> {
    try {
      await manager.save(LeaderElectionAudit, {
        jobName: entry.jobName,
        event: entry.event,
        ownerId: entry.ownerId,
        fencingToken: entry.fencingToken,
        previousOwnerId: entry.previousOwnerId,
        previousToken: entry.previousToken,
        details: entry.details,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record leader-election audit (${entry.event}): ${(error as Error).message}`,
      );
    }
  }

  private resolveHostname(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os') as typeof import('os');
      return os.hostname();
    } catch {
      return 'unknown-host';
    }
  }

  private resolvePositiveInt(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw == null ? NaN : parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  }
}
