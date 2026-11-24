import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { SchedulerRegistry } from '@nestjs/schedule';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export type ShutdownHook = () => void | Promise<void>;

export interface ShutdownResult {
  timedOut: boolean;
  failed: boolean;
}

@Injectable()
export class GracefulShutdownService {
  private readonly logger = new Logger(GracefulShutdownService.name);
  private readonly stopHooks = new Map<string, ShutdownHook>();
  private readonly operations = new Set<Promise<unknown>>();
  private schedulerRegistry?: SchedulerRegistry;
  private draining = false;
  private activeRequests = 0;
  private shutdownPromise?: Promise<ShutdownResult>;
  private readonly idleWaiters = new Set<() => void>();
  private scheduledStopFailed = false;

  get isDraining(): boolean {
    return this.draining;
  }

  setSchedulerRegistry(registry: SchedulerRegistry): void {
    this.schedulerRegistry = registry;
  }

  registerStopHook(name: string, hook: ShutdownHook): void {
    if (this.stopHooks.has(name)) {
      throw new Error(`Shutdown hook "${name}" is already registered`);
    }
    this.stopHooks.set(name, hook);
  }

  middleware = (
    _request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    if (this.draining) {
      response
        .status(503)
        .setHeader('Retry-After', '1')
        .json({ statusCode: 503, message: 'Server is shutting down' });
      return;
    }

    this.activeRequests++;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      this.activeRequests--;
      this.notifyIdle();
    };

    response.once('finish', finish);
    response.once('close', finish);
    try {
      next();
    } catch (error) {
      finish();
      throw error;
    }
  };

  runTracked<T>(name: string, operation: () => Promise<T>): Promise<T> {
    if (this.draining) {
      return Promise.reject(
        new Error(`Cannot start "${name}" while the application is draining`),
      );
    }

    const task = Promise.resolve().then(operation);
    this.operations.add(task);
    task.then(
      () => {
        this.operations.delete(task);
        this.notifyIdle();
      },
      (error: unknown) => {
        this.operations.delete(task);
        this.notifyIdle();
        this.logger.error(
          `Tracked operation "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    return task;
  }

  shutdown(
    closeApplication: () => Promise<void>,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ): Promise<ShutdownResult> {
    if (this.shutdownPromise) {
      this.logger.warn(
        'Repeated shutdown signal received; shutdown is already in progress',
      );
      return this.shutdownPromise;
    }

    this.draining = true;
    const scheduledWork = this.stopScheduledWork();
    this.shutdownPromise = this.performShutdown(
      closeApplication,
      timeoutMs,
      scheduledWork,
    );
    return this.shutdownPromise;
  }

  private async performShutdown(
    closeApplication: () => Promise<void>,
    timeoutMs: number,
    scheduledWork: Promise<void>,
  ): Promise<ShutdownResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const result: ShutdownResult = {
      timedOut: false,
      failed: this.scheduledStopFailed,
    };
    this.logger.log(
      'Shutdown drain started; new HTTP and background work is rejected',
    );

    const hooks = Promise.all([
      scheduledWork,
      ...Array.from(this.stopHooks, async ([name, hook]) => {
        try {
          await hook();
          this.logger.log(`Shutdown hook completed: ${name}`);
        } catch (error) {
          result.failed = true;
          this.logger.error(
            `Shutdown hook failed (${name}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    ]);

    if (!(await this.awaitBeforeDeadline(hooks, deadline))) {
      result.timedOut = true;
      this.logger.error('Timed out stopping scheduled work and consumers');
    }
    if (this.scheduledStopFailed) result.failed = true;

    if (!(await this.awaitBeforeDeadline(this.waitForIdle(), deadline))) {
      result.timedOut = true;
      this.logger.error(
        `Shutdown drain timed out with ${this.activeRequests} HTTP request(s) and ${this.operations.size} tracked operation(s) still active`,
      );
    } else {
      this.logger.log('Shutdown drain completed; no tracked work remains');
    }

    const close = Promise.resolve()
      .then(closeApplication)
      .catch((error: unknown) => {
        result.failed = true;
        this.logger.error(
          `Failed to close Nest application: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    if (!(await this.awaitBeforeDeadline(close, deadline))) {
      result.timedOut = true;
      this.logger.error('Timed out closing Nest application resources');
    } else {
      this.logger.log('Nest application resources closed');
    }

    return result;
  }

  private async stopScheduledWork(): Promise<void> {
    if (!this.schedulerRegistry) return;

    let cronJobs: ReturnType<SchedulerRegistry['getCronJobs']> = new Map();
    try {
      cronJobs = this.schedulerRegistry.getCronJobs();
    } catch (error) {
      this.recordScheduledStopFailure('scheduled jobs', error);
    }

    const cronStops = Array.from(cronJobs, async ([name, job]) => {
      try {
        await job.stop();
      } catch (error) {
        this.recordScheduledStopFailure(`scheduled job "${name}"`, error);
      }
    });

    let intervals: string[] = [];
    try {
      intervals = this.schedulerRegistry.getIntervals();
    } catch (error) {
      this.recordScheduledStopFailure('scheduled intervals', error);
    }
    for (const name of intervals) {
      try {
        this.schedulerRegistry.deleteInterval(name);
      } catch (error) {
        this.recordScheduledStopFailure(`scheduled interval "${name}"`, error);
      }
    }

    let timeouts: string[] = [];
    try {
      timeouts = this.schedulerRegistry.getTimeouts();
    } catch (error) {
      this.recordScheduledStopFailure('scheduled timeouts', error);
    }
    for (const name of timeouts) {
      try {
        this.schedulerRegistry.deleteTimeout(name);
      } catch (error) {
        this.recordScheduledStopFailure(`scheduled timeout "${name}"`, error);
      }
    }
    await Promise.all(cronStops);
  }

  private recordScheduledStopFailure(context: string, error: unknown): void {
    this.scheduledStopFailed = true;
    this.logger.error(
      `Failed to stop ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private async waitForIdle(): Promise<void> {
    while (this.activeRequests > 0 || this.operations.size > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
  }

  private notifyIdle(): void {
    if (this.activeRequests > 0 || this.operations.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async awaitBeforeDeadline(
    operation: Promise<unknown>,
    deadline: number,
  ): Promise<boolean> {
    const observed = operation.then(
      () => true,
      (error: unknown) => {
        this.logger.error(
          `Shutdown operation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return true;
      },
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      void observed;
      return false;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        observed,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), remainingMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
