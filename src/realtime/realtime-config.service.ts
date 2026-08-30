import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RealtimeConfig } from './realtime.config';

function nonNegativeInt(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid realtime configuration: ${name} must be a non-negative integer, received "${value}"`,
    );
  }
  return parsed;
}

/**
 * Provides a validated, fail-closed {@link RealtimeConfig} from environment.
 * An explicitly provided but invalid value throws instead of silently applying
 * a fallback, matching the issue's "fail closed on incompatible configuration".
 */
@Injectable()
export class RealtimeConfigService {
  constructor(private readonly configService: ConfigService) {}

  getConfig(): RealtimeConfig {
    const pollIntervalMs = nonNegativeInt(
      'REALTIME_POLL_INTERVAL_MS',
      this.configService.get<string>('REALTIME_POLL_INTERVAL_MS'),
      1000,
    );
    const maxPublishBatch = nonNegativeInt(
      'REALTIME_MAX_PUBLISH_BATCH',
      this.configService.get<string>('REALTIME_MAX_PUBLISH_BATCH'),
      100,
    );
    const heartbeatIntervalMs = nonNegativeInt(
      'REALTIME_HEARTBEAT_INTERVAL_MS',
      this.configService.get<string>('REALTIME_HEARTBEAT_INTERVAL_MS'),
      15000,
    );
    const maxBacklog = nonNegativeInt(
      'REALTIME_MAX_BACKLOG',
      this.configService.get<string>('REALTIME_MAX_BACKLOG'),
      1000,
    );
    const maxReplayRows = nonNegativeInt(
      'REALTIME_MAX_REPLAY_ROWS',
      this.configService.get<string>('REALTIME_MAX_REPLAY_ROWS'),
      5000,
    );

    return {
      pollIntervalMs,
      maxPublishBatch,
      heartbeatIntervalMs,
      maxBacklog,
      maxReplayRows,
    };
  }
}
