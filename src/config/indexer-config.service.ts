import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EventIndexerConfig,
  DatabaseConfig,
  ContractConfig,
} from './event-indexer.config';

/**
 * Provides validated configuration for the event indexer
 * Loads from environment variables with sensible defaults
 */
@Injectable()
export class IndexerConfigService {
  constructor(private configService: ConfigService) {}

  /**
   * Get event indexer configuration
   */
  getEventIndexerConfig(): EventIndexerConfig {
    return {
      rpcUrl: this.configService.get('OPTIMISM_RPC_URL', 'https://mainnet.optimism.io'),
      chainId: parseInt(this.configService.get('CHAIN_ID', '10'), 10),
      confirmationsRequired: parseInt(
        this.configService.get('CONFIRMATIONS_REQUIRED', '12'),
        10,
      ),
      blockRangePerBatch: parseInt(
        this.configService.get('BLOCK_RANGE_PER_BATCH', '5000'),
        10,
      ),
      maxRetryAttempts: parseInt(this.configService.get('MAX_RETRY_ATTEMPTS', '3'), 10),
      pollingIntervalMs: parseInt(
        this.configService.get('POLLING_INTERVAL_MS', '12000'),
        10,
      ),
      contracts: this.getContractConfigs(),
    };
  }

  /**
   * Get database configuration
   */
  getDatabaseConfig(): DatabaseConfig {
    return {
      host: this.configService.get('DATABASE_HOST', 'localhost'),
      port: parseInt(this.configService.get('DATABASE_PORT', '5432'), 10),
      username: this.configService.get('DATABASE_USER', 'postgres'),
      password: this.configService.get('DATABASE_PASSWORD', 'postgres'),
      database: this.configService.get('DATABASE_NAME', 'truthbounty'),
      synchronize: this.configService.get('DATABASE_SYNCHRONIZE', 'false') === 'true',
      logging: this.configService.get('DATABASE_LOGGING', 'false') === 'true',
    };
  }

  /**
   * Parse contract configurations from environment or default
   * Contract configurations should be provided as JSON env var
   */
  private getContractConfigs(): ContractConfig[] {
    const contractsJson = this.configService.get('INDEXED_CONTRACTS', '[]');
    try {
      return JSON.parse(contractsJson);
    } catch (error) {
      console.warn('Failed to parse INDEXED_CONTRACTS, using empty array', error);
      return [];
    }
  }
}
