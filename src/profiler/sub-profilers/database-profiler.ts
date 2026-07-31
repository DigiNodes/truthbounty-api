import { Injectable, Logger } from '@nestjs/common';
import { ProfilerService } from '../profiler.service';

@Injectable()
export class DatabaseProfiler {
  private readonly logger = new Logger(DatabaseProfiler.name);

  constructor(private readonly profilerService: ProfilerService) {}

  /**
   * Wraps and profiles a database operation.
   * @param query SQL or query description
   * @param entity Name of entity or table
   * @param fn Executable async database operation
   * @param metadata Additional metadata
   */
  async profileQuery<T>(
    query: string,
    entity: string = 'unknown',
    fn: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<T> {
    const span = this.profilerService.startSpan(
      `DB:${entity}`,
      'db',
      undefined,
      {
        query: this.sanitizeQuery(query),
        entity,
        ...metadata,
      },
    );

    const startTime = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;

      const isSlow = this.profilerService.isSlowQuery(durationMs);
      this.profilerService.endSpan(span.id, 'ok', {
        durationMs,
        isSlowQuery: isSlow,
      });

      if (isSlow) {
        this.logger.warn(
          `Slow Database Query Detected (${durationMs}ms) [Entity: ${entity}]: ${query.substring(0, 150)}`,
        );
      }

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

  /**
   * Sanitizes database queries by masking sensitive patterns.
   */
  private sanitizeQuery(query: string): string {
    if (!query) return '';
    return query
      .replace(/password\s*=\s*'[^']*'/gi, "password='***'")
      .replace(/secret\s*=\s*'[^']*'/gi, "secret='***'")
      .replace(/token\s*=\s*'[^']*'/gi, "token='***'");
  }
}
