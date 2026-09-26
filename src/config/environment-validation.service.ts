import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';

/**
 * Environment Configuration Validation Service
 *
 * Validates required environment variables at startup, rejects placeholders,
 * redacts sensitive values in logs, and prevents unsupported chain/address combinations.
 *
 * Implements V2-BE-068: Validate Secrets and Environment Configuration at Startup
 */
@Injectable()
export class EnvironmentValidationService implements OnModuleInit {
  private readonly logger = new Logger(EnvironmentValidationService.name);

  // Required environment variables by category
  private readonly requiredSecrets = {
    // Database
    database: ['DATABASE_URL'],

    // Authentication
    auth: ['JWT_SECRET', 'JWT_EXPIRATION', 'REFRESH_TOKEN_EXPIRATION'],

    // SIWE
    siwe: ['SIWE_DOMAIN'],

    // Blockchain
    blockchain: ['RPC_URL', 'CHAIN_ID'],

    // Redis
    redis: ['REDIS_HOST', 'REDIS_PORT'],

    // IPFS
    ipfs: ['IPFS_GATEWAY_URL', 'IPFS_API_URL'],
  };

  // Placeholder patterns that indicate non-production values
  private readonly placeholderPatterns = [
    /^your[-_]?.*$/i,
    /^change[-_]?me$/i,
    /^placeholder$/i,
    /^example\.com$/i,
    /^localhost$/i,
    /^127\.0\.0\.1$/i,
    /^test$/i,
    /^dummy$/i,
    /^secret$/i,
    /^password$/i,
    /^changeme$/i,
    /^your-secret-key$/i,
    /^your-jwt-secret$/i,
    /^your-database-url$/i,
  ];

  // Chain configurations that are supported
  private readonly supportedChains = new Map<number, { name: string; rpcUrlPattern: RegExp }>([
    [1, { name: 'Ethereum Mainnet', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [10, { name: 'Optimism', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [100, { name: 'Gnosis Chain', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [137, { name: 'Polygon', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [42161, { name: 'Arbitrum One', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [8453, { name: 'Base', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [84532, { name: 'Base Sepolia', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [11155111, { name: 'Sepolia', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [420, { name: 'Optimism Goerli', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
    [11155420, { name: 'OP Sepolia', rpcUrlPattern: /^(https?:\/\/|wss?:\/\/).*/ }],
  ]);

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.validateAll();
  }

  /**
   * Validate all environment configuration
   */
  async validateAll(): Promise<void> {
    this.logger.log('Starting environment configuration validation...');

    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Validate required secrets
    for (const [category, keys] of Object.entries(this.requiredSecrets)) {
      for (const key of keys) {
        const value = this.configService.get<string>(key);
        const error = this.validateSecret(key, value, category);
        if (error) {
          errors.push(error);
        }
      }
    }

    // 2. Validate chain configuration
    const chainError = this.validateChainConfiguration();
    if (chainError) {
      errors.push(chainError);
    }

    // 3. Validate address configuration
    const addressErrors = this.validateAddressConfiguration();
    errors.push(...addressErrors);

    // 4. Validate unsupported combinations
    const comboWarnings = this.validateCombinations();
    warnings.push(...comboWarnings);

    // 5. Validate rate limiting configuration
    const rateLimitErrors = this.validateRateLimiting();
    errors.push(...rateLimitErrors);

    // Log warnings
    for (const warning of warnings) {
      this.logger.warn(`[ENV VALIDATION] ${warning}`);
    }

    // Throw if errors exist
    if (errors.length > 0) {
      const errorMessage = `Environment validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    this.logger.log('Environment configuration validation passed successfully');
  }

  /**
   * Validate a single secret value
   */
  private validateSecret(key: string, value: string | undefined, category: string): string | null {
    if (!value || value.trim() === '') {
      return `[${category.toUpperCase()}] Required environment variable ${key} is not set`;
    }

    // Check for placeholder patterns
    for (const pattern of this.placeholderPatterns) {
      if (pattern.test(value.trim())) {
        return `[${category.toUpperCase()}] ${key} appears to contain a placeholder value: ${this.redactValue(value)}`;
      }
    }

    // Specific validations
    if (key === 'JWT_SECRET' && value.length < 32) {
      return `[AUTH] JWT_SECRET must be at least 32 characters (current: ${value.length})`;
    }

    if (key === 'DATABASE_URL') {
      const dbError = this.validateDatabaseUrl(value);
      if (dbError) return `[DATABASE] ${dbError}`;
    }

    if (key === 'RPC_URL') {
      const rpcError = this.validateRpcUrl(value);
      if (rpcError) return `[BLOCKCHAIN] ${rpcError}`;
    }

    if (key === 'CHAIN_ID') {
      const chainId = parseInt(value, 10);
      if (isNaN(chainId) || chainId <= 0) {
        return `[BLOCKCHAIN] CHAIN_ID must be a positive integer (got: ${value})`;
      }
      if (!this.supportedChains.has(chainId)) {
        return `[BLOCKCHAIN] CHAIN_ID ${chainId} is not a supported chain. Supported: ${Array.from(this.supportedChains.keys()).join(', ')}`;
      }
    }

    return null;
  }

  /**
   * Validate database URL format and security
   */
  private validateDatabaseUrl(url: string): string | null {
    if (!url.startsWith('postgresql://') && !url.startsWith('postgres://') && !url.startsWith('sqlite:')) {
      return 'DATABASE_URL must be a postgresql:// or sqlite: connection string';
    }

    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      if (this.configService.get('NODE_ENV') === 'production') {
        return 'DATABASE_URL points to localhost in production environment';
      }
    }

    if (!url.includes('sslmode=require') && url.startsWith('postgresql://')) {
      // Check if SSL is explicitly disabled
      if (!url.includes('sslmode=disable') && !url.includes('sslmode=allow')) {
        this.logger.warn('[ENV VALIDATION] DATABASE_URL should use sslmode=require for production');
      }
    }

    return null;
  }

  /**
   * Validate RPC URL format
   */
  private validateRpcUrl(url: string): string | null {
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('ws://') && !url.startsWith('wss://')) {
      return 'RPC_URL must start with http://, https://, ws://, or wss://';
    }

    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      if (this.configService.get('NODE_ENV') === 'production') {
        return 'RPC_URL points to localhost in production environment';
      }
    }

    return null;
  }

  /**
   * Validate chain configuration
   */
  private validateChainConfiguration(): string | null {
    const chainId = this.configService.get<number>('CHAIN_ID');
    const rpcUrl = this.configService.get<string>('RPC_URL');

    if (!chainId) {
      return 'CHAIN_ID is required';
    }

    if (!rpcUrl) {
      return 'RPC_URL is required';
    }

    const chainConfig = this.supportedChains.get(chainId);
    if (chainConfig) {
      if (!chainConfig.rpcUrlPattern.test(rpcUrl)) {
        return `RPC_URL format does not match expected pattern for chain ${chainId} (${chainConfig.name})`;
      }
    }

    return null;
  }

  /**
   * Validate address configuration
   */
  private validateAddressConfiguration(): string[] {
    const errors: string[] = [];

    const addresses = {
      'CONTRACT_ADDRESS': this.configService.get<string>('CONTRACT_ADDRESS'),
      'TREASURY_ADDRESS': this.configService.get<string>('TREASURY_ADDRESS'),
      'VERIFIER_ADDRESS': this.configService.get<string>('VERIFIER_ADDRESS'),
      'FEE_RECIPIENT': this.configService.get<string>('FEE_RECIPIENT'),
    };

    for (const [key, address] of Object.entries(addresses)) {
      if (address) {
        if (!this.isValidEthAddress(address)) {
          errors.push(`[ADDRESS] ${key} is not a valid Ethereum address: ${this.redactValue(address)}`);
        }

        // Check for zero address
        if (address.toLowerCase() === '0x0000000000000000000000000000000000000000') {
          errors.push(`[ADDRESS] ${key} cannot be the zero address`);
        }
      }
    }

    return errors;
  }

  /**
   * Validate unsupported chain/address combinations
   */
  private validateCombinations(): string[] {
    const warnings: string[] = [];

    const chainId = this.configService.get<number>('CHAIN_ID');
    const contractAddress = this.configService.get<string>('CONTRACT_ADDRESS');

    // Check if contract address is set for the configured chain
    if (chainId && contractAddress) {
      // This would require a contract registry - for now just warn
      if (this.configService.get('NODE_ENV') === 'production') {
        warnings.push(`[COMBINATION] Verify CONTRACT_ADDRESS is deployed on chain ${chainId} before production deployment`);
      }
    }

    return warnings;
  }

  /**
   * Validate rate limiting configuration
   */
  private validateRateLimiting(): string[] {
    const errors: string[] = [];

    const redisHost = this.configService.get<string>('REDIS_HOST');
    const redisPort = this.configService.get<number>('REDIS_PORT');

    if (!redisHost) {
      errors.push('[RATE_LIMIT] REDIS_HOST is required for distributed rate limiting');
    }

    if (!redisPort || redisPort <= 0 || redisPort > 65535) {
      errors.push('[RATE_LIMIT] REDIS_PORT must be a valid port number (1-65535)');
    }

    // Validate TTL values are reasonable
    const ttlKeys = [
      'RATE_LIMIT_CLAIMS_TTL',
      'RATE_LIMIT_VOTES_TTL',
      'RATE_LIMIT_DISPUTES_TTL',
      'RATE_LIMIT_AUTH_TTL',
      'RATE_LIMIT_AI_TTL',
      'RATE_LIMIT_DEFAULT_TTL',
    ];

    for (const key of ttlKeys) {
      const value = this.configService.get<string>(key);
      if (value) {
        const ttl = parseInt(value, 10);
        if (isNaN(ttl) || ttl <= 0) {
          errors.push(`[RATE_LIMIT] ${key} must be a positive integer (got: ${value})`);
        }
        if (ttl > 86400000) { // 24 hours in ms
          this.logger.warn(`[RATE_LIMIT] ${key} TTL is very high (${ttl}ms)`);
        }
      }
    }

    return errors;
  }

  /**
   * Check if a value is a valid Ethereum address
   */
  private isValidEthAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Redact sensitive values for logging
   */
  private redactValue(value: string): string {
    if (!value || value.length <= 8) {
      return '***';
    }
    const visibleChars = 4;
    const start = value.substring(0, visibleChars);
    const end = value.substring(value.length - visibleChars);
    const middle = '*'.repeat(Math.min(value.length - visibleChars * 2, 20));
    return `${start}${middle}${end}`;
  }

  /**
   * Get validation summary for health checks
   */
  getValidationSummary(): Record<string, any> {
    const summary: Record<string, any> = {
      timestamp: new Date().toISOString(),
      nodeEnv: this.configService.get('NODE_ENV') || 'development',
      validatedCategories: Object.keys(this.requiredSecrets),
      supportedChains: Array.from(this.supportedChains.keys()),
    };

    // Add redacted config values for debugging
    for (const [category, keys] of Object.entries(this.requiredSecrets)) {
      summary[category] = {};
      for (const key of keys) {
        const value = this.configService.get<string>(key);
        summary[category][key] = value ? this.redactValue(value) : 'NOT SET';
      }
    }

    return summary;
  }
}