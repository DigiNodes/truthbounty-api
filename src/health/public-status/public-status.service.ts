import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HealthService } from '../health.service';
import { FinalizedCursorService } from '../../indexer/finalized-cursor/finalized-cursor.service';
import { PublicStatusResponseDto } from './public-status.dto';
import {
  PUBLIC_STATUS_OPTIONS,
  PublicStatusOptions,
  loadPublicStatusOptions,
} from './public-status.options';
import {
  PublicStatusInputs,
  projectPublicStatus,
} from './public-status.projector';

export interface PublicStatusSnapshot {
  body: PublicStatusResponseDto;
  /** Seconds remaining before the cached projection expires (>= 0). */
  maxAgeSeconds: number;
}

/**
 * Builds and caches the public status projection. Each internal source is
 * read independently; a source that fails or is unconfigured becomes `null`
 * and is projected as `unknown`, never as healthy.
 */
@Injectable()
export class PublicStatusService {
  private readonly logger = new Logger(PublicStatusService.name);
  private readonly options: PublicStatusOptions;
  private cached: {
    body: PublicStatusResponseDto;
    expiresAtMs: number;
  } | null = null;
  private inFlight: Promise<PublicStatusResponseDto> | null = null;

  constructor(
    private readonly healthService: HealthService,
    @Optional()
    private readonly finalizedCursorService?: FinalizedCursorService,
    @Optional() @Inject(PUBLIC_STATUS_OPTIONS) options?: PublicStatusOptions,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {
    this.options = options ?? loadPublicStatusOptions();
  }

  getOptions(): PublicStatusOptions {
    return this.options;
  }

  async getSnapshot(): Promise<PublicStatusSnapshot> {
    const nowMs = this.clock().getTime();
    if (!this.cached || nowMs >= this.cached.expiresAtMs) {
      if (!this.inFlight) {
        this.inFlight = this.build().finally(() => {
          this.inFlight = null;
        });
      }
      const body = await this.inFlight;
      this.cached = {
        body,
        expiresAtMs:
          new Date(body.generatedAt).getTime() +
          this.options.cacheTtlSeconds * 1000,
      };
    }
    const remaining = Math.max(
      0,
      Math.ceil((this.cached.expiresAtMs - this.clock().getTime()) / 1000),
    );
    return { body: this.cached.body, maxAgeSeconds: remaining };
  }

  private async build(): Promise<PublicStatusResponseDto> {
    const [dependencies, cursor, web] = await Promise.all([
      this.safely('dependencies', () =>
        this.healthService.getDependencyHealth(),
      ),
      this.safely('finalized_cursor', async () =>
        this.finalizedCursorService
          ? this.finalizedCursorService.getConfiguredStatus(this.clock())
          : null,
      ),
      this.safely('web', () => this.probeWeb()),
    ]);

    const inputs: PublicStatusInputs = {
      now: this.clock(),
      dependencies,
      cursor,
      release: this.finalizedCursorService?.getConfiguredBinding() ?? null,
      web,
    };
    return projectPublicStatus(inputs, {
      staleAfterSeconds: this.options.staleAfterSeconds,
      cacheTtlSeconds: this.options.cacheTtlSeconds,
    });
  }

  private async probeWeb(): Promise<{
    reachable: boolean;
    observedAt: Date;
  } | null> {
    const url = this.options.webHealthUrl;
    if (!url) return null;
    let reachable: boolean;
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.webProbeTimeoutMs),
      });
      reachable = response.status >= 200 && response.status < 400;
    } catch {
      reachable = false;
    }
    return { reachable, observedAt: this.clock() };
  }

  /** Runs one source; failures are logged by source name only and yield null. */
  private async safely<T>(
    source: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch {
      this.logger.warn(`Public status source unavailable: ${source}`);
      return null;
    }
  }
}
