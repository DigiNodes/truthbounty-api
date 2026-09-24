import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { ContractConfig } from '../config/event-indexer.config';

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
 * Validates chain, contract address and ABI configuration at startup,
 * before the indexer begins consuming blocks.
 *
 * This is "V2-BE-009 — validate chain/addresses/ABIs at startup": catch
 * misconfigurations early and fail fast (fail-closed) rather than emitting
 * garbage into the indexer or routing to the wrong chain.
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

  constructor(private readonly configService: ConfigService) {}

  /**
   * Entry point invoked on application bootstrap. Throws (fail-closed) if
   * any configured contract/chain/ABI is invalid.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get('BLOCKCHAIN_STARTUP_VALIDATION') === 'false') {
      this.logger.warn('Blockchain startup validation disabled by config');
      return;
    }

    const errors: string[] = [];

    const contracts = this.getContracts();
    for (const contract of contracts) {
      const result = this.validateContract(contract);
      if (!result.valid) {
        errors.push(
          `Contract "${result.name}" (${result.address}) invalid: ${result.errors.join('; ')}`,
        );
      }
    }

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

    this.logger.log(
      `Blockchain startup validation passed (${contracts.length} contracts, ABI/address checks ok)`,
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

  private getContracts(): ContractConfig[] {
    const raw = this.configService.get<string>('INDEXED_CONTRACTS', '[]');
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ContractConfig[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Network-backed checks: RPC reachability, chain-id match and contract-code
   * presence. Only when enabled (fail-closed default).
   */
  private async validateChainAndCode(
    contracts: ContractConfig[],
  ): Promise<string[]> {
    const errors: string[] = [];
    const rpcUrl = this.configService.get<string>(
      'OPTIMISM_RPC_URL',
      'https://mainnet.optimism.io',
    );
    const expectedChainId = parseInt(
      this.configService.get<string>('CHAIN_ID', '10'),
      10,
    );

    let provider: ethers.JsonRpcProvider;
    try {
      provider = new ethers.JsonRpcProvider(rpcUrl);
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(expectedChainId)) {
        errors.push(
          `RPC chain id ${network.chainId} does not match configured CHAIN_ID ${expectedChainId}`,
        );
      }
    } catch (err) {
      errors.push(`RPC unreachable at ${rpcUrl}: ${String(err)}`);
      return errors;
    }

    for (const contract of contracts) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
        continue; // shape errors already reported by pure validation
      }
      try {
        const code = await provider.getCode(contract.address);
        if (!code || code === '0x' || code === '0x0') {
          errors.push(
            `no contract deployed at ${contract.address} (${contract.name})`,
          );
        }
      } catch (err) {
        errors.push(
          `failed to read code at ${contract.address}: ${String(err)}`,
        );
      }
    }

    return errors;
  }
}
