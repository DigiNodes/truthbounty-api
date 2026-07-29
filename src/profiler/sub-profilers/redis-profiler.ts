import { Injectable, Logger } from '@nestjs/common';
import { ProfilerService } from '../profiler.service';

@Injectable()
export class RedisProfiler {
  private readonly logger = new Logger(RedisProfiler.name);

  constructor(private readonly profilerService: ProfilerService) {}

  /**
   * Wraps and profiles a Redis command execution.
   * @param command Redis command name (GET, SET, HGET, etc.)
   * @param key Redis key or key pattern
   * @param fn Executable async Redis operation
   * @param metadata Additional metadata
   */
  async profileOperation<T>(
    command: string,
    key: string = '',
    fn: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<T> {
    const span = this.profilerService.startSpan(
      `REDIS:${command.toUpperCase()}`,
      'redis',
      undefined,
      {
        command: command.toUpperCase(),
        keyPattern: this.extractKeyPattern(key),
        ...metadata,
      },
    );

    const startTime = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;

      const hitMiss =
        result === null || result === undefined
          ? 'miss'
          : command.toUpperCase() === 'GET'
            ? 'hit'
            : 'n/a';

      this.profilerService.endSpan(span.id, 'ok', {
        durationMs,
        hitMiss,
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

  private extractKeyPattern(key: string): string {
    if (!key) return '';
    return key.replace(/:[0-9a-f-]{8,}/gi, ':*').replace(/:\d+/g, ':*');
  }
}
