import { Injectable, Logger } from '@nestjs/common';
import { ProfilerService } from '../profiler.service';

@Injectable()
export class BlockchainProfiler {
  private readonly logger = new Logger(BlockchainProfiler.name);

  constructor(private readonly profilerService: ProfilerService) {}

  /**
   * Wraps and profiles a blockchain RPC or Smart Contract invocation.
   * @param method Name of RPC method or contract function (e.g. eth_call, verifyClaim)
   * @param network Target network (e.g. optimism, ethereum, stellar)
   * @param fn Executable async RPC call
   * @param metadata Additional metadata (contractAddress, gasLimit, blockNumber, etc.)
   */
  async profileRpcCall<T>(
    method: string,
    network: string = 'optimism',
    fn: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<T> {
    const span = this.profilerService.startSpan(
      `RPC:${network}:${method}`,
      'blockchain',
      undefined,
      {
        method,
        network,
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
