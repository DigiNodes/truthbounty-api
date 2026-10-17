import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

import { ContractConfig } from '../config/event-indexer.config';
import {
  CanonicalReleaseManifest,
  ReleaseManifestContract,
  ReleaseManifestAdapter,
} from '../config/release-manifest.adapter';
import {
  RealtimeConfig,
  RealtimeTopicDefinition,
} from './types';
import { RealtimeConfigService } from './realtime-config.service';

/**
 * Result of validating a single contract config at startup.
 */
export interface ContractValidationResult {
  name: string;
  address: string;
  valid: boolean;
  errors: string[];
}

/**
 * Result of validating the canonical release manifest at startup.
 */
export interface ReleaseManifestValidationResult {
  releaseId: string;
  chainId: number;
  deploymentBlock: number;
  contracts: ReleaseManifestContract[];
  manifestAgeMs: number;
}

/**
 * Environment modes that determine fail-closed behaviour.
 */
export type EnvironmentMode = 'local' | 'development' |
  'test' | 'staging' | 'production';

/**
 * Result of validating the realtime configuration at startup.
 */
export interface RealtimeConfigValidationResult {
  valid: boolean;
  errors: string[];
  topics: RealtimeTopicDefinition[];
  config?: RealtimeConfig;
}

/**
 * Validates chain, contract address and ABI configuration at startup,
 * before the indexer begins consuming blocks.
 *
 * This is "V2-BE-009 — validate chain/addresses/ABIs at startup": catch
 * misconfigurations early and fail fast (fail-closed) rather than emitting
 * garbage into the indexer or routing to the wrong chain.
 *
 * Stab-BE-007 extends this to consume the versioned canonical contract
 * release manifest rather than hand-maintained addresses/events, and to
 * validate chain ID, release ID, deployment block, addresses, ABI/event
 * checksums and manifest age. It fails closed in staging/production when
 * required release data is absent or inconsistent, and keeps local dev
 * explicit and visibly non-production.
 *
 * PREWAVE-BE-035 extends this to validate the realtime configuration
 * (stream origins, topics, retention, heartbeat, payload limits, supported
 * release) and to authorize subscription topics per principal/capability.
 * Invalid realtime config fails startup/readiness and topic names cannot
 * inject Redis/WebSocket patterns.
 *
 * Address validation is *pure* (checksum + shape). RPC/chain-id and
 * contract-code checks require a network round trip and are only performed
 * when `BLOCKCHAIN_STARTUP_RPC_CHECK=true` (default true) so the app fails
 * closed in production but still boots in offline/offline-dev environments
 * via `BLOCKCHAIN_STARTUP_RPC_CHECK=false`.
 */
@Injectable()
export class StartupValidationService {
  private readonly logger = new Logger(StartupValidationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly releaseManifestAdapter: ReleaseManifestAdapter,
    private readonly realtimeConfigService: RealtimeConfigService,
  ) {}

  /**
   * Entry point invoked on application bootstrap. Throws (fail-closed) if
   * any configured contract/chain/ABI is invalid.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get('BLOCKCHAIN_STARTUP_VALIDATION') === 'false') {
      this.logger.warn(
        'Blockchain startup validation disabled by config',
      );
      return;
    }

    const envManifest = this.releaseManifestAdapter.load();
    const isLocal = this.isLocalMode();

    const errors: string[] = [];

    // 1. Release manifest validation (fail-closed outside local).
    errors.push(...(this.validateReleaseManifest(envManifest, isLocal)));

    // 2. Contract config validation.
    const contracts = this.getContracts();
    if (contracts.length === 0 && !isLocal) {
      errors.push(
        'INDEXED_CONTRACTS is empty; indexer configuration cannot start outside explicit local mode',
      );
    }
    for (const contract of contracts) {
      const result = this.validateContract(contract);
      if (!result.valid) {
        errors.push(
          `Contract "${result.name}" (${result.address}) address invalid: ${result.errors.join('; ')}`,
        );
      }
    }

    // 3. Release manifest <-> contract config consistency.
    if (envManifest) {
      errors.push(...(this.validateManifestConsistency(envManifest, contracts)));
    }

    // 4. Realtime configuration validation (fail-closed outside local).
    const realtimeResult = this.validateRealtimeConfig(isLocal);
    errors.push(...realtimeResult.errors);

    // 5. Network-backed checks.
    if (this.configService.get('BLOCKCHAIN_STARTUP_RPC_CHECK') !== 'false') {
      errors.push(...(await this.validateChainAndCode(contracts)));
    }

    if (errors.length > 0) {
      const msg = `Blockchain startup validation failed:\n${errors
        .map((e) => `  - ${e}`)
        .join('\n')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    const releaseId = envManifest?.releaseId ?? 'unknown';
    this.logger.log(
      `Blockchain startup validation passed (release=${releaseId}, ${contracts.length} contracts, ABI/address checks ok, ${realtimeResult.topics.length} realtime topics)`,
    );
  }

  /**
   * Validate a single contract's address shape, checksum and ABI parseability.
   * Pure: no network I/O.
   */
  validateContract(contract: ContractConfig): ContractValidationResult {
    const errors: string[] = [];

    if (!contract.address) {
      errors.push('missing address');
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
      errors.push(`address "${contract.address}" is not a valid 20-byte hex`);
    } else {
      try {
        const checksummed = ethers.getAddress(contract.address);
        if (checksummed !== contract.address) {
          errors.push(
            `address "${contract.address}" is not checksummed (expected ${checksummed})`,
          );
        }
      } catch (err) {
        errors.push(
          `address "${contract.address}" failed checksum: ${String(err)}`,
        );
      }
    }

    if (!Array.isArray(contract.events) || contract.events.length === 0) {
      errors.push('no events configured');
    } else {
      for (const event of contract.events) {
        if (!event.abi) {
          errors.push(`event "${event.name}" has no ABI fragment`);
          continue;
        }
        try {
          // Throws if the fragment is malformed.
          const fragment = ethers.Fragment.from(event.abi);
          if (fragment.type !== 'event') {
            errors.push(
              `event "${event.name}" ABI is not an event fragment (got ${fragment.type})`,
            );
          }
        } catch (err) {
          errors.push(`event "${event.name}" ABI is invalid: ${String(err)}`);
        }
      }
    }

    return {
      name: contract.name ?? contract.address,
      address: contract.address,
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate the canonical release manifest against the configured chain
   * and manifest age. Fails closed outside local mode.
   */
  validateReleaseManifest(
    manifest: CanonicalReleaseManifest | null,
    isLocal: boolean,
  ): string[] {
    const errors: string[] = [];

    if (!manifest) {
      if (!isLocal) {
        errors.push(
          'Canonical release manifest is missing or unreadable; required outside local mode',
        );
      }
      return errors;
    }

    const expectedChainId = this.getConfiguredChainId();
    if (expectedChainId !== null && manifest.chainId !== expectedChainId) {
      errors.push(
        `manifest chainId ${manifest.chainId} does not match configured chainId ${expectedChainId}`,
      );
    }

    if (!manifest.releaseId) {
      errors.push('manifest is missing a releaseId');
    }

    if (!Number.isFinite(manifest.deploymentBlock) || manifest.deploymentBlock < 0) {
      errors.push('manifest has an invalid deploymentBlock');
    }

    const maxAgeMs = this.getMaxManifestAgeMs();
    const ageMs = Date.now() - Date.parse(manifest.generatedAt ?? '');
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
      errors.push(
        `manifest is stale (age ${ageMs}ms > max ${maxAgeMs}ms)`,
      );
    }

    if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
      errors.push('manifest declares no contracts');
    } else {
      for (const c of manifest.contracts) {
        if (!c.address || !/^0x[a-fA-F0-9]{40}$/.test(c.address)) {
          errors.push(`manifest contract "${c.name}" has an invalid address`);
        }
        if (!c.artifactChecksum) {
          errors.push(`manifest contract "${c.name}" is missing an artifact checksum`);
        }
      }
    }

    return errors;
  }

  /**
   * Validate realtime configuration (stream origins, topics, retention,
   * heartbeat, payload limits, supported release). Fails closed outside
   * local mode.
   */
  validateRealtimeConfig(isLocal: boolean): RealtimeConfigValidationResult {
    const result = this.realtimeConfigService.validate({ isLocal });
    return {
      valid: result.valid,
      errors: result.errors,
      topics: result.config?.topics ?? [],
      config: result.config,
    };
  }

  /**
   * Validate release manifest <-> contract config consistency.
   */
  private validateManifestConsistency(
    manifest: CanonicalReleaseManifest,
    contracts: ContractConfig[],
  ): string[] {
    const errors: string[] = [];
    const manifestAddresses = new Set(
      (manifest.contracts ?? []).map(
        (c) => c.address.toLowerCase(),
      ),
    );
    for (const contract of contracts) {
      if (!manifestAddresses.has(contract.address.toLowerCase())) {
        errors.push(
          `Contract "${contract.name ?? contract.address}" is not declared in the release manifest`,
        );
      }
    }
    return errors;
  }

  /**
   * Return true when running in explicit local mode.
   */
  private isLocalMode(): boolean {
    const env = this.configService.get<string>('NODE_ENV') ?? 'development';
    return env === 'local';
  }

  /**
   * Return the configured chain ID, or null when unset.
   */
  private getConfiguredChainId(): number | null {
    const raw = this.configService.get<string>('CHAIN_ID');
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Maximum acceptable manifest age in milliseconds.
   */
  private getMaxManifestAgeMs(): number {
    const raw = this.configService.get<string>('RELEASE_MANIFEST_MAX_AGE_MS');
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : 24 * 60 * 60 * 1000;
  }

  /**
   * Load contract configuration from the config service.
   */
  private getContracts(): ContractConfig[] {
    const raw = this.configService.get<unknown>('INDEXED_CONTRACTS');
    if (Array.isArray(raw)) {
      return raw as ContractConfig[];
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed as ContractConfig[];
        }
      } catch {
        this.logger.warn('INDEXED_CONTRACTS could not be parsed as JSON');
      }
    }
    return [];
  }

  /**
   * Perform network-backed chain ID and contract code checks.
   */
  private async validateChainAndCode(
    contracts: ContractConfig[],
  ): Promise<string[]> {
    const errors: string[] = [];
    const rpcUrl = this.configService.get<string>('RPC_URL');
    if (!rpcUrl) {
      return errors;
    }

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const network = await provider.getNetwork();
      const expectedChainId = this.getConfiguredChainId();
      if (expectedChainId !== null && Number(network.chainId) !== expectedChainId) {
        errors.push(
          `RPC chainId ${Number(network.chainId)} does not match configured chainId ${expectedChainId}`,
        );
      }

      for (const contract of contracts) {
        if (!contract.address) {
          continue;
        }
        const code = await provider.getCode(contract.address);
        if (!code || code === '0x') {
          errors.push(
            `Contract "${contract.name ?? contract.address}" has no code at ${contract.address} on chain ${Number(network.chainId)}`,
          );
        }
      }
    } catch (err) {
      errors.push(`RPC validation failed: ${String(err)}`);
    }

    return errors;
  }
}
