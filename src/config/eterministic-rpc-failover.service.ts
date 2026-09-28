import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider } from 'ethers';

export enum ProviderHealthStatus {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
}

export interface ProviderNodeState {
  index: number;
  url: string;
  sanitizedUrl: string;
  provider: JsonRpcProvider;
  status: ProviderHealthStatus;
  consecutiveFailures: number;
  lastFailureTimestamp?: number;
  lastSuccessTimestamp?: number;
  latencyMs?: number;
}

export class RpcFailoverExhaustedException extends Error {
  constructor(public readonly errors: Array<{ endpoint: string; error: string }>) {
    super(
      `Deterministic RPC Failover Exhausted: All configured providers failed. Details: ${JSON.stringify(
        errors,
      )}`,
    );
    this.name = 'RpcFailoverExhaustedException';
  }
}

export class ChainMismatchException extends Error {
  constructor(expectedChainId: number, actualChainId: number, endpoint: string) {
    super(
      `Chain ID mismatch on RPC endpoint [${endpoint}]: expected ${expectedChainId}, got ${actualChainId}`,
    );
    this.name = 'ChainMismatchException';
  }
}

@Injectable()
export class DeterministicRpcFailoverService implements OnModuleInit {
  private readonly logger = new Logger(DeterministicRpcFailoverService.name);
  private providers: ProviderNodeState[] = [];
  private expectedChainId: number;
  private timeoutMs: number;
  private readonly cooldownPeriodMs = 30000; // 30s cooldown before retrying degraded provider

  constructor(private readonly configService: ConfigService) {
    const primaryUrl = this.configService.get<string>(
      'blockchain.rpcUrl',
      'https://mainnet.optimism.io',
    );
    const fallbackUrls = this.configService.get<string[]>(
      'blockchain.fallbackRpcUrls',
      [],
    );
    this.expectedChainId = this.configService.get<number>('blockchain.chainId', 10);
    this.timeoutMs = this.configService.get<number>('blockchain.rpcTimeoutMs', 10000);

    const allUrls = [primaryUrl, ...fallbackUrls].filter(Boolean);
    this.initProviders(allUrls);
  }

  async onModuleInit() {
    this.logger.log(
      `Initialized Deterministic RPC Failover with ${this.providers.length} endpoint(s). Expected Chain ID: ${this.expectedChainId}`,
    );
  }

  private initProviders(urls: string[]) {
    this.providers = urls.map((url, index) => {
      const sanitizedUrl = this.sanitizeUrl(url);
      const provider = new JsonRpcProvider(url, undefined, {
        staticNetwork: false,
      });

      return {
        index,
        url,
        sanitizedUrl,
        provider,
        status: ProviderHealthStatus.HEALTHY,
        consecutiveFailures: 0,
      };
    });
  }

  /**
   * Sanitizes URLs so sensitive API keys or credentials are not leaked into logs.
   */
  public sanitizeUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.password) {
        parsed.password = '***';
      }
      // Mask key in paths or query params (e.g. /v3/<key> or ?apikey=<key>)
      const pathParts = parsed.pathname.split('/');
      const maskedPathParts = pathParts.map((part) =>
        part.length > 20 ? `${part.slice(0, 4)}...${part.slice(-4)}` : part,
      );
      parsed.pathname = maskedPathParts.join('/');

      for (const [key] of parsed.searchParams.entries()) {
        if (/key|secret|token|auth/i.test(key)) {
          parsed.searchParams.set(key, '***');
        }
      }
      return parsed.toString();
    } catch {
      return 'invalid-url';
    }
  }

  /**
   * Validates that the provider is connected to the canonical Optimism EVM chain.
   */
  public async verifyChain(node: ProviderNodeState): Promise<void> {
    const network = await Promise.race([
      node.provider.getNetwork(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Chain verification timeout')), this.timeoutMs),
      ),
    ]);

    const actualChainId = Number(network.chainId);
    if (actualChainId !== this.expectedChainId) {
      node.status = ProviderHealthStatus.UNHEALTHY;
      throw new ChainMismatchException(this.expectedChainId, actualChainId, node.sanitizedUrl);
    }
  }

  /**
   * Executes a blockchain operation deterministically across ordered providers.
   * If a provider fails, falls over to the next. If all fail, throws RpcFailoverExhaustedException.
   */
  async execute<T>(
    operation: (provider: JsonRpcProvider) => Promise<T>,
    operationName: string = 'rpc_call',
  ): Promise<T> {
    const failures: Array<{ endpoint: string; error: string }> = [];
    const orderedNodes = this.getOrderedEligibleProviders();

    if (orderedNodes.length === 0) {
      throw new RpcFailoverExhaustedException([
        { endpoint: 'none', error: 'No configured RPC providers are eligible or available' },
      ]);
    }

    for (const node of orderedNodes) {
      const startTime = Date.now();
      try {
        const result = await Promise.race([
          operation(node.provider),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`RPC request timeout after ${this.timeoutMs}ms`)),
              this.timeoutMs,
            ),
          ),
        ]);

        const latency = Date.now() - startTime;
        this.recordSuccess(node, latency);
        return result;
      } catch (err: any) {
        const latency = Date.now() - startTime;
        const errorMsg = err?.message || String(err);
        failures.push({ endpoint: node.sanitizedUrl, error: errorMsg });

        this.recordFailure(node, errorMsg, latency);
        this.logger.warn(
          `RPC operation [${operationName}] failed on provider [${node.sanitizedUrl}]. Failing over to next deterministic provider. Error: ${errorMsg}`,
        );
      }
    }

    // Invariant: Fail closed when all providers fail. Never invent state.
    this.logger.error(
      `All RPC providers exhausted for operation [${operationName}]. Fail closed protocol invariant engaged.`,
    );
    throw new RpcFailoverExhaustedException(failures);
  }

  /**
   * Returns eligible providers in deterministic priority order (index 0, 1, 2...).
   */
  private getOrderedEligibleProviders(): ProviderNodeState[] {
    const now = Date.now();

    return [...this.providers].sort((a, b) => {
      // Prioritize HEALTHY over DEGRADED, and DEGRADED over UNHEALTHY
      const statusWeight = {
        [ProviderHealthStatus.HEALTHY]: 0,
        [ProviderHealthStatus.DEGRADED]: 1,
        [ProviderHealthStatus.UNHEALTHY]: 2,
      };

      const weightDiff = statusWeight[a.status] - statusWeight[b.status];
      if (weightDiff !== 0) return weightDiff;

      // Maintain deterministic priority by index
      return a.index - b.index;
    }).filter((node) => {
      if (node.status === ProviderHealthStatus.UNHEALTHY) {
        // Retry unhealthy node only if cooldown period has elapsed
        if (node.lastFailureTimestamp && now - node.lastFailureTimestamp > this.cooldownPeriodMs) {
          return true;
        }
        return false;
      }
      return true;
    });
  }

  private recordSuccess(node: ProviderNodeState, latencyMs: number) {
    node.status = ProviderHealthStatus.HEALTHY;
    node.consecutiveFailures = 0;
    node.lastSuccessTimestamp = Date.now();
    node.latencyMs = latencyMs;
  }

  private recordFailure(node: ProviderNodeState, error: string, latencyMs: number) {
    node.consecutiveFailures += 1;
    node.lastFailureTimestamp = Date.now();
    node.latencyMs = latencyMs;

    if (node.consecutiveFailures >= 3) {
      node.status = ProviderHealthStatus.UNHEALTHY;
    } else {
      node.status = ProviderHealthStatus.DEGRADED;
    }
  }

  /**
   * Observable health status query for diagnostics and health endpoints.
   */
  getStatuses() {
    return this.providers.map((p) => ({
      index: p.index,
      endpoint: p.sanitizedUrl,
      status: p.status,
      consecutiveFailures: p.consecutiveFailures,
      lastSuccessTimestamp: p.lastSuccessTimestamp,
      lastFailureTimestamp: p.lastFailureTimestamp,
      latencyMs: p.latencyMs,
    }));
  }

  /**
   * Returns the current primary active provider for direct read-only calls.
   */
  async getActiveProvider(): Promise<JsonRpcProvider> {
    const eligible = this.getOrderedEligibleProviders();
    if (eligible.length === 0) {
      throw new RpcFailoverExhaustedException([
        { endpoint: 'all', error: 'No available healthy RPC providers' },
      ]);
    }
    return eligible[0].provider;
  }
}
