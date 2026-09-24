import { Injectable, Logger } from '@nestjs/common';
import { ProfilerService } from '../profiler.service';

@Injectable()
export class JobProfiler {
  private readonly logger = new Logger(JobProfiler.name);

  constructor(private readonly profilerService: ProfilerService) {}

  /**
   * Wraps and profiles a background queue job execution.
   * @param jobName Name of the job
   * @param queueName Queue name (e.g. jobs-queue, notification-queue)
   * @param fn Async execution handler of the job
   * @param metadata Job payload or parameters metadata
   */
  async profileJob<T>(
    jobName: string,
    queueName: string = 'default',
    fn: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<T> {
    const trace = this.profilerService.startTrace(
      `JOB:${queueName}:${jobName}`,
      'queue',
      {
        jobName,
        queueName,
        ...metadata,
      },
    );

    const startTime = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;

      this.profilerService.endTrace(trace.id, {
        durationMs,
        status: 'ok',
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.profilerService.endTrace(trace.id, {
        durationMs,
        status: 'error',
        errorMessage,
      });
      throw error;
    }
  }
}
