// src/indexer/abi-versioning.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { ethers, Interface, EventFragment, FunctionFragment } from 'ethers';
import { createHash } from 'crypto';

export interface ABIManifest {
  contractName: string;
  contractAddress: string;
  chainId: number;
  abi: ethers.Fragment[];
  abiHash: string;
  deployedAt: number; // Unix timestamp
  deploymentBlock: bigint;
  version: string; // Semantic version
  sourceHash?: string; // Source code hash for verification
  metadata?: Record<string, any>;
}

export interface ABIRegistryEntry {
  id: string;
  contractName: string;
  contractAddress: string;
  chainId: number;
  abiHash: string;
  abi: ethers.Fragment[];
  version: string;
  deployedAt: Date;
  deploymentBlock: bigint;
  sourceHash?: string;
  isActive: boolean;
  deprecatedAt?: Date;
  deprecatedReason?: string;
}

export interface EventDecoderConfig {
  contractAddress: string;
  chainId: number;
  eventName: string;
  abi: ethers.Fragment[];
  strictMode: boolean;
  unknownEventBehavior: 'reject' | 'quarantine' | 'log';
}

export interface DecodedEvent {
  name: string;
  args: Record<string, any>;
  signature: string;
  topic0: string;
  contractAddress: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

export interface QuarantinedEvent {
  id: string;
  chainId: number;
  contractAddress: string;
  rawTopics: string[];
  rawData: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  timestamp: Date;
  reason: string;
  possibleMatches?: Array<{ name: string; similarity: number }>;
}

/**
 * ABI Versioning and Event Decoding Service
 *
 * Binds decoders to deployment manifests and contract versions;
 * quarantines unknown selectors/topics instead of guessing schemas.
 *
 * Implements V2-BE-054: Version ABI Decoders and Reject Unknown Events
 */
@Injectable()
export class ABIVersioningService implements OnModuleInit {
  private readonly logger = new Logger(ABIVersioningService.name);
  private readonly abiRegistry = new Map<string, ABIRegistryEntry>();
  private readonly eventDecoders = new Map<string, EventDecoderConfig>();

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.loadRegistry();
    this.logger.log(`ABI Versioning Service initialized with ${this.abiRegistry.size} contracts`);
  }

  /**
   * Register a contract's ABI from deployment manifest
   */
  async registerABI(
    manifest: ABIManifest,
    options: { force?: boolean; deprecatePrevious?: boolean } = {},
  ): Promise<ABIRegistryEntry> {
    const key = this.getRegistryKey(manifest.chainId, manifest.contractAddress);
    const existing = this.abiRegistry.get(key);

    if (existing && !options.force) {
      if (existing.abiHash === manifest.abiHash) {
        this.logger.log(`ABI already registered for ${manifest.contractName} at ${manifest.contractAddress} (chain ${manifest.chainId})`);
        return existing;
      }

      if (options.deprecatePrevious) {
        await this.deprecateContract(manifest.chainId, manifest.contractAddress, 'New version deployed');
      } else {
        throw new Error(`ABI already registered with different hash. Use force=true or deprecatePrevious=true`);
      }
    }

    // Validate ABI
    this.validateABI(manifest.abi);

    // Extract events and functions
    const events = manifest.abi.filter((f) => f.type === 'event');
    const functions = manifest.abi.filter((f) => f.type === 'function');

    // Register event decoders
    for (const event of events) {
      await this.registerEventDecoder({
        contractAddress: manifest.contractAddress,
        chainId: manifest.chainId,
        eventName: event.name,
        abi: [event],
        strictMode: true,
        unknownEventBehavior: 'reject',
      });
    }

    // Create registry entry
    const entry: ABIRegistryEntry = {
      id: randomBytes(16).toString('hex'),
      contractName: manifest.contractName,
      contractAddress: manifest.contractAddress.toLowerCase(),
      chainId: manifest.chainId,
      abiHash: manifest.abiHash,
      abi: manifest.abi,
      version: manifest.version,
      deployedAt: new Date(manifest.deployedAt * 1000),
      deploymentBlock: manifest.deploymentBlock,
      sourceHash: manifest.sourceHash,
      isActive: true,
      metadata: manifest.metadata,
    };

    // Persist to database
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(
        `INSERT INTO "v2_abi_registry" 
        ("id", "contract_name", "contract_address", "chain_id", "abi_hash", "abi", "version", "deployed_at", "deployment_block", "source_hash", "is_active", "metadata")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)`,
        [
          entry.id,
          entry.contractName,
          entry.contractAddress,
          entry.chainId,
          entry.abiHash,
          JSON.stringify(entry.abi.map((f) => f.format())),
          entry.version,
          entry.deployedAt,
          entry.deploymentBlock.toString(),
          entry.sourceHash || null,
          JSON.stringify(entry.metadata || {}),
        ]
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // Update in-memory registry
    this.abiRegistry.set(key, entry);

    this.logger.log(`Registered ABI for ${manifest.contractName} v${manifest.version} at ${manifest.contractAddress} (chain ${manifest.chainId})`);
    return entry;
  }

  /**
   * Decode an event log using registered ABI
   */
  async decodeEvent(
    chainId: number,
    contractAddress: string,
    topics: string[],
    data: string,
    blockNumber: bigint,
    transactionHash: string,
    logIndex: number,
  ): Promise<DecodedEvent | null> {
    const key = this.getDecoderKey(chainId, contractAddress);
    const decoder = this.eventDecoders.get(key);

    if (!decoder) {
      this.logger.warn(`No decoder registered for ${contractAddress} on chain ${chainId}`);
      return null;
    }

    // Find matching event by topic0
    const topic0 = topics[0];
    const eventFragment = decoder.abi.find((f) => f.type === 'event' && f.topicHash === topic0);

    if (!eventFragment) {
      // Unknown event - handle according to config
      await this.handleUnknownEvent(
        chainId,
        contractAddress,
        topics,
        data,
        blockNumber,
        transactionHash,
        logIndex,
        decoder.unknownEventBehavior,
      );
      return null;
    }

    // Decode using ethers Interface
    const iface = new Interface([eventFragment]);
    let decoded: any;

    try {
      decoded = iface.decodeEventLog(eventFragment, data, topics);
    } catch (error) {
      this.logger.error(`Failed to decode event ${eventFragment.name}: ${error.message}`);
      await this.handleUnknownEvent(
        chainId,
        contractAddress,
        topics,
        data,
        blockNumber,
        transactionHash,
        logIndex,
        'reject',
      );
      return null;
    }

    // Convert to plain object
    const args: Record<string, any> = {};
    for (let i = 0; i < eventFragment.inputs.length; i++) {
      const input = eventFragment.inputs[i];
      const value = decoded[i];
      args[input.name] = this.normalizeValue(value, input.type);
    }

    return {
      name: eventFragment.name,
      args,
      signature: eventFragment.format(),
      topic0,
      contractAddress: contractAddress.toLowerCase(),
      blockNumber,
      transactionHash,
      logIndex,
    };
  }

  /**
   * Register an event decoder
   */
  async registerEventDecoder(config: EventDecoderConfig): Promise<void> {
    const key = this.getDecoderKey(config.chainId, config.contractAddress);
    const existing = this.eventDecoders.get(key);

    if (existing) {
      // Merge ABIs
      const newEvents = config.abi.filter((f) => f.type === 'event');
      for (const event of newEvents) {
        if (!existing.abi.some((e) => e.type === 'event' && e.name === event.name)) {
          existing.abi.push(event);
        }
      }
    } else {
      this.eventDecoders.set(key, config);
    }

    this.logger.debug(`Registered event decoder for ${config.contractAddress} on chain ${config.chainId}: ${config.eventName}`);
  }

  /**
   * Get registry entry
   */
  getRegistryEntry(chainId: number, contractAddress: string): ABIRegistryEntry | undefined {
    return this.abiRegistry.get(this.getRegistryKey(chainId, contractAddress));
  }

  /**
   * List all registered contracts
   */
  listContracts(): ABIRegistryEntry[] {
    return Array.from(this.abiRegistry.values()).filter((e) => e.isActive);
  }

  /**
   * Get quarantined events
   */
  async getQuarantinedEvents(
    filters: {
      chainId?: number;
      contractAddress?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<QuarantinedEvent[]> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      let query = `SELECT * FROM "v2_quarantined_events" WHERE 1=1`;
      const params: any[] = [];
      let paramIndex = 1;

      if (filters.chainId) {
        query += ` AND "chain_id" = $${paramIndex++}`;
        params.push(filters.chainId);
      }
      if (filters.contractAddress) {
        query += ` AND "contract_address" = $${paramIndex++}`;
        params.push(filters.contractAddress.toLowerCase());
      }
      query += ` ORDER BY "timestamp" DESC`;
      if (filters.limit) {
        query += ` LIMIT $${paramIndex++}`;
        params.push(filters.limit);
      }
      if (filters.offset) {
        query += ` OFFSET $${paramIndex++}`;
        params.push(filters.offset);
      }

      const result = await queryRunner.query(query, params);
      return result.map(this.mapToQuarantinedEvent);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Resolve quarantined event (approve or reject)
   */
  async resolveQuarantinedEvent(
    eventId: string,
    action: 'approve' | 'reject',
    resolution?: { eventName: string; abiFragment: any },
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (action === 'approve' && resolution) {
        // Register the event decoder
        await this.registerEventDecoder({
          chainId: 0, // Will be filled from event
          contractAddress: '',
          eventName: resolution.eventName,
          abi: [resolution.abiFragment],
          strictMode: true,
          unknownEventBehavior: 'reject',
        });
      }

      await queryRunner.query(
        `UPDATE "v2_quarantined_events" SET "resolved" = TRUE, "resolution" = $1 WHERE "id" = $2`,
        [action, eventId]
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Load registry from database
   */
  private async loadRegistry(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const result = await queryRunner.query(
        `SELECT * FROM "v2_abi_registry" WHERE "is_active" = TRUE`
      );

      for (const row of result) {
        const entry = this.mapToRegistryEntry(row);
        const key = this.getRegistryKey(entry.chainId, entry.contractAddress);
        this.abiRegistry.set(key, entry);

        // Re-register event decoders
        const events = entry.abi.filter((f) => f.type === 'event');
        for (const event of events) {
          await this.registerEventDecoder({
            contractAddress: entry.contractAddress,
            chainId: entry.chainId,
            eventName: event.name,
            abi: [event],
            strictMode: true,
            unknownEventBehavior: 'reject',
          });
        }
      }

      this.logger.log(`Loaded ${this.abiRegistry.size} contracts from ABI registry`);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Deprecate a contract version
   */
  private async deprecateContract(chainId: number, contractAddress: string, reason: string): Promise<void> {
    const key = this.getRegistryKey(chainId, contractAddress);
    const existing = this.abiRegistry.get(key);

    if (!existing) return;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(
        `UPDATE "v2_abi_registry" SET "is_active" = FALSE, "deprecated_at" = NOW(), "deprecated_reason" = $1 WHERE "id" = $2`,
        [reason, existing.id]
      );

      await queryRunner.commitTransaction();

      existing.isActive = false;
      existing.deprecatedAt = new Date();
      existing.deprecatedReason = reason;

      this.logger.log(`Deprecated contract ${existing.contractName} at ${contractAddress} (chain ${chainId}): ${reason}`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Handle unknown event according to configuration
   */
  private async handleUnknownEvent(
    chainId: number,
    contractAddress: string,
    topics: string[],
    data: string,
    blockNumber: bigint,
    transactionHash: string,
    logIndex: number,
    behavior: 'reject' | 'quarantine' | 'log',
  ): Promise<void> {
    const topic0 = topics[0];

    this.logger.warn(`Unknown event from ${contractAddress} on chain ${chainId}: topic0=${topic0}`);

    if (behavior === 'reject') {
      throw new Error(`Unknown event selector ${topic0} from ${contractAddress} on chain ${chainId}`);
    }

    if (behavior === 'quarantine') {
      await this.quarantineEvent(chainId, contractAddress, topics, data, blockNumber, transactionHash, logIndex);
    }

    // Log behavior always logs
    this.logger.log(`Unknown event quarantined/logged: ${topic0} from ${contractAddress}`);
  }

  /**
   * Quarantine unknown event for manual review
   */
  private async quarantineEvent(
    chainId: number,
    contractAddress: string,
    topics: string[],
    data: string,
    blockNumber: bigint,
    transactionHash: string,
    logIndex: number,
  ): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Find possible matches from known events
      const possibleMatches = this.findPossibleMatches(topics[0]);

      await queryRunner.query(
        `INSERT INTO "v2_quarantined_events" 
        ("id", "chain_id", "contract_address", "raw_topics", "raw_data", "block_number", "transaction_hash", "log_index", "timestamp", "reason", "possible_matches")
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)`,
        [
          randomBytes(16).toString('hex'),
          chainId,
          contractAddress.toLowerCase(),
          topics,
          data,
          blockNumber.toString(),
          transactionHash,
          logIndex,
          `Unknown event selector: ${topics[0]}`,
          JSON.stringify(possibleMatches),
        ]
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Find possible matches for unknown event selector
   */
  private findPossibleMatches(topic0: string): Array<{ name: string; similarity: number }> {
    const matches: Array<{ name: string; similarity: number }> = [];

    for (const [, decoder] of this.eventDecoders) {
      for (const fragment of decoder.abi) {
        if (fragment.type === 'event') {
          // Simple similarity based on topic hash prefix
          if (fragment.topicHash.startsWith(topic0.slice(0, 10))) {
            matches.push({
              name: `${decoder.contractAddress}:${fragment.name}`,
              similarity: this.calculateSimilarity(fragment.topicHash, topic0),
            });
          }
        }
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  private calculateSimilarity(hash1: string, hash2: string): number {
    let matches = 0;
    const minLen = Math.min(hash1.length, hash2.length);
    for (let i = 0; i < minLen; i++) {
      if (hash1[i] === hash2[i]) matches++;
    }
    return matches / minLen;
  }

  private normalizeValue(value: any, type: string): any {
    if (value === undefined || value === null) return null;

    if (type.includes('uint') || type.includes('int')) {
      return value.toString();
    }

    if (type === 'address') {
      return value.toLowerCase();
    }

    if (type === 'bool') {
      return Boolean(value);
    }

    if (type.startsWith('bytes')) {
      return value;
    }

    if (type.startsWith('string')) {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value.map((v) => this.normalizeValue(v, type.replace('[]', '')));
    }

    return value;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getRegistryKey(chainId: number, contractAddress: string): string {
    return `${chainId}:${contractAddress.toLowerCase()}`;
  }

  private getDecoderKey(chainId: number, contractAddress: string): string {
    return `${chainId}:${contractAddress.toLowerCase()}`;
  }

  private validateABI(abi: ethers.Fragment[]): void {
    if (!abi || abi.length === 0) {
      throw new Error('ABI cannot be empty');
    }

    // Check for duplicate events
    const events = abi.filter((f) => f.type === 'event');
    const eventNames = new Set<string>();
    for (const event of events) {
      if (eventNames.has(event.name)) {
        throw new Error(`Duplicate event name: ${event.name}`);
      }
      eventNames.add(event.name);
    }
  }

  private mapToRegistryEntry(row: any): ABIRegistryEntry {
    return {
      id: row.id,
      contractName: row.contract_name,
      contractAddress: row.contract_address,
      chainId: parseInt(row.chain_id, 10),
      abiHash: row.abi_hash,
      abi: JSON.parse(row.abi).map((f: string) => ethers.Fragment.from(f)),
      version: row.version,
      deployedAt: new Date(row.deployed_at),
      deploymentBlock: BigInt(row.deployment_block),
      sourceHash: row.source_hash,
      isActive: row.is_active,
      deprecatedAt: row.deprecated_at ? new Date(row.deprecated_at) : undefined,
      deprecatedReason: row.deprecated_reason,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private mapToQuarantinedEvent(row: any): QuarantinedEvent {
    return {
      id: row.id,
      chainId: parseInt(row.chain_id, 10),
      contractAddress: row.contract_address,
      rawTopics: row.raw_topics,
      rawData: row.raw_data,
      blockNumber: BigInt(row.block_number),
      transactionHash: row.transaction_hash,
      logIndex: parseInt(row.log_index, 10),
      timestamp: new Date(row.timestamp),
      reason: row.reason,
      possibleMatches: row.possible_matches ? JSON.parse(row.possible_matches) : undefined,
    };
  }
}