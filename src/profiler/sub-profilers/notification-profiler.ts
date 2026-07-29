import { Injectable, Logger } from '@nestjs/common';
import { ProfilerService } from '../profiler.service';

@Injectable()
export class NotificationProfiler {
  private readonly logger = new Logger(NotificationProfiler.name);

  constructor(private readonly profilerService: ProfilerService) {}

  /**
   * Wraps and profiles a notification dispatch or external webhook execution.
   * @param type Notification type or webhook target (e.g. email, push, webhook, discord)
   * @param target Recipient or URL domain
   * @param fn Async notification delivery handler
   * @param metadata Additional metadata
   */
  async profileNotification<T>(
    type: string,
    target: string = '',
    fn: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<T> {
    const span = this.profilerService.startSpan(
      `NOTIF:${type}`,
      'notification',
      undefined,
      {
        type,
        target,
        ...metadata,
      },
    );

    const startTime = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;

      this.profilerService.endSpan(span.id, 'ok', {
        durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.profilerService.endSpan(span.id, 'error', {
        durationMs,
        errorMessage,
      });
      throw error;
    }
  }
}
