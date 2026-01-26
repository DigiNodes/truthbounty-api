/**
 * Configuration interface for the event indexer
 * Defines RPC connection, contract details, and indexing parameters
 */
export interface EventIndexerConfig {
  /**
   * Optimism RPC endpoint URL
   */
  rpcUrl: string;

  /**
   * Chain ID (10 for Optimism Mainnet, 11155420 for Sepolia)
   */
  chainId: number;

  /**
   * Block confirmations threshold before marking events as finalized
   * Protects against chain reorgs
   */
  confirmationsRequired: number;

  /**
   * Number of blocks to fetch per RPC call
   * Smaller = more calls but better error handling
   */
  blockRangePerBatch: number;

  /**
   * Maximum retry attempts for failed events
   */
  maxRetryAttempts: number;

  /**
   * Polling interval in milliseconds for new blocks
   */
  pollingIntervalMs: number;

  /**
   * Contract subscriptions configuration
   */
  contracts: ContractConfig[];
}

/**
 * Configuration for a specific smart contract to index
 */
export interface ContractConfig {
  /**
   * Contract address
   */
  address: string;

  /**
   * Contract name (for logging/identification)
   */
  name: string;

  /**
   * Block number to start indexing from
   * Useful for backfilling or resuming from a known state
   */
  startBlock: number;

  /**
   * Events to monitor for this contract
   */
  events: EventConfig[];
}

/**
 * Configuration for a specific event to index from a contract
 */
export interface EventConfig {
  /**
   * Event name (e.g., 'Staked', 'RewardClaimed')
   */
  name: string;

  /**
   * Event signature hash (keccak256(signature))
   * E.g., "0x..." for event Staked(address indexed user, uint256 amount)
   */
  signature: string;

  /**
   * ABI fragment for decoding the event
   */
  abi: any;
}

/**
 * Database connection configuration
 */
export interface DatabaseConfig {
  /**
   * Database host
   */
  host: string;

  /**
   * Database port
   */
  port: number;

  /**
   * Database username
   */
  username: string;

  /**
   * Database password
   */
  password: string;

  /**
   * Database name
   */
  database: string;

  /**
   * Whether to synchronize schema
   */
  synchronize: boolean;

  /**
   * Whether to show SQL logs
   */
  logging: boolean;
}
