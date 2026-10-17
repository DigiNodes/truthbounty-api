import { isIP } from 'node:net';

/** One definition for parsing, compatibility aliases and operator documentation. */
export interface Field<T> {
  readonly parse: (value: string) => T;
  readonly description: string;
  readonly default?: string;
  readonly aliases?: readonly string[];
  readonly productionRequired?: boolean;
  readonly secret?: boolean;
}

function text(
  options: Omit<Field<string>, 'parse' | 'description'> = {},
): Field<string> {
  return {
    description: 'non-empty string',
    ...options,
    parse: (value) => value,
  };
}

function integer(
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): Field<number> {
  return {
    description: `integer ${min}..${max}`,
    default: String(fallback),
    parse(value) {
      if (!/^\d+$/.test(value)) throw new Error('expected an integer');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error('integer outside allowed range');
      }
      return parsed;
    },
  };
}

function optionalInteger(): Field<number> {
  const { parse, description } = integer(1);
  return { parse, description };
}

function boolean(fallback: boolean): Field<boolean> {
  return {
    description: 'true or false',
    default: String(fallback),
    parse(value) {
      if (value !== 'true' && value !== 'false')
        throw new Error('expected true or false');
      return value === 'true';
    },
  };
}

function choice<const T extends readonly string[]>(
  values: T,
  fallback: T[number],
): Field<T[number]> {
  return {
    description: values.join(' | '),
    default: fallback,
    parse(value) {
      if (!values.includes(value)) throw new Error('unsupported option');
      return value;
    },
  };
}

function url(protocols = ['https:', 'http:'], required = false): Field<string> {
  return {
    description: `URL (${protocols.join(', ')})`,
    productionRequired: required,
    secret: true,
    parse(value) {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol) || !parsed.hostname)
        throw new Error('invalid URL');
      return value;
    },
  };
}

function list(): Field<readonly string[]> {
  return {
    description: 'comma-separated non-empty values',
    parse(value) {
      const parts = value.split(',').map((part) => part.trim());
      if (parts.some((part) => !part) || new Set(parts).size !== parts.length)
        throw new Error('invalid list');
      return Object.freeze(parts);
    },
  };
}

const secret = (required = false) =>
  text({ secret: true, productionRequired: required });
const address: Field<string> = {
  description: 'non-zero 20-byte EVM address',
  parse(value) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
      throw new Error('invalid address');
    }
    return value;
  },
};
const hostname: Field<string> = {
  description: 'hostname or IP address (without scheme, credentials or port)',
  parse(value) {
    if (
      !isIP(value) &&
      !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/.test(value)
    )
      throw new Error('invalid host');
    return value;
  },
};
const clockTime: Field<string> = {
  description: '24-hour HH:mm time',
  parse(value) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
      throw new Error('invalid time');
    return value;
  },
};
const duration: Field<string> = {
  description: 'positive duration with s, m, h or d unit',
  parse(value) {
    if (!/^[1-9]\d*[smhd]$/.test(value)) throw new Error('invalid duration');
    return value;
  },
};

export const runtimeSchema = {
  APP_VERSION: {
    ...text({ default: 'dev' }),
    aliases: ['npm_package_version'],
  },
  NODE_ENV: choice(
    ['local', 'development', 'test', 'staging', 'production'],
    'development',
  ),
  LOCAL_DEV_MODE: { ...boolean(false), aliases: ['STAB_LOCAL_MODE'] },
  SIWE_ALLOWED_ORIGINS: list(),
  CAPABILITY_TOKEN_SIGNING_KEY: secret(true),
  ADMIN_AUDIT_RETENTION_DAYS: integer(365, 1, 3650),
  SIWE_ALLOWED_DOMAINS: list(),
  SIWE_EXPECTED_STATEMENT: text(),
  SIWE_SUPPORTED_CHAIN_IDS: {
    ...list(),
    description: 'comma-separated Optimism chain IDs',
    parse(value: string) {
      const chains = list().parse(value);
      if (chains.some((chain) => !['10', '11155420'].includes(chain))) {
        throw new Error('unsupported chain');
      }
      return chains;
    },
  },
  OPERATIONS_AUDIT_MAX: integer(10000),
  INDEXER_MAX_FINALIZED_LAG_BLOCKS: integer(150, 0),
  INDEXER_MAX_HEAD_AGE_SECONDS: integer(120, 0),
  INDEXER_RELEASE_ID: text(),
  INDEXER_DEPLOYMENT_BLOCK: {
    parse: integer(0, 0).parse,
    description: 'non-negative safe integer',
  },
  INDEXER_ARTIFACT_CHECKSUM: {
    ...text(),
    description: '64-character lowercase SHA-256',
    parse(value: string) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid checksum');
      return value;
    },
  },
  PUBLIC_STATUS_CACHE_TTL_SECONDS: integer(15),
  PUBLIC_STATUS_STALE_AFTER_SECONDS: integer(120),
  PUBLIC_STATUS_WEB_HEALTH_URL: url(),
  PUBLIC_STATUS_WEB_PROBE_TIMEOUT_MS: integer(2000),
  PUBLIC_STATUS_RATE_LIMIT: integer(60),
  PUBLIC_STATUS_RATE_WINDOW_SECONDS: integer(60),
  ABUSE_SIGNALS_ENABLED: boolean(true),
  ABUSE_SIGNALS_ENFORCEMENT_ENABLED: boolean(false),
  ABUSE_SIGNALS_SUBJECT_SALT: {
    ...secret(),
    description: 'secret of at least 32 characters',
    parse(value: string) {
      if (value.trim().length < 32) throw new Error('short salt');
      return value.trim();
    },
  },
  ABUSE_SIGNALS_WINDOW_SECONDS: integer(300),
  ABUSE_SIGNALS_MAX_ACTION_SECONDS: integer(900),
  ABUSE_SIGNALS_MAX_ACTIONS_PER_SUBJECT: integer(3),
  ABUSE_SIGNALS_TRUSTED_PROXY_HOPS: integer(0, 0),
  ABUSE_SIGNALS_SCRAPE_MAX_READS: integer(600),
  ABUSE_SIGNALS_SCRAPE_MAX_ROUTES: integer(40),
  ABUSE_SIGNALS_STUFFING_MAX_FAILURES: integer(20),
  ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_CREDENTIALS: integer(5),
  ABUSE_SIGNALS_STUFFING_MAX_DISTINCT_SUBJECTS: integer(10),
  ABUSE_SIGNALS_SPAM_MAX_WRITES: integer(30),
  ABUSE_SIGNALS_SPAM_MAX_DUPLICATE_PAYLOADS: integer(10),
  ABUSE_SIGNALS_WEBHOOK_MAX_ENDPOINT_WRITES: integer(15),
  ABUSE_SIGNALS_WEBHOOK_MAX_SECRET_ROTATIONS: integer(5),
  ABUSE_SIGNALS_WEBHOOK_MAX_DELIVERIES: integer(200),
  ABUSE_SIGNALS_STREAM_MAX_CONNECTIONS: integer(25),
  ABUSE_SIGNALS_STREAM_MAX_SUBSCRIBE_OPS: integer(60),
  ABUSE_SIGNALS_STREAM_MAX_MESSAGES: integer(300),
  ABUSE_SIGNALS_SUPPORT_MAX_REQUESTS: integer(30),
  ABUSE_SIGNALS_SUPPORT_MAX_DUPLICATE_REQUESTS: integer(20),
  ABUSE_SIGNALS_SUPPORT_MAX_DISTINCT_CONTACTS: integer(25),
  PORT: integer(3000, 1, 65535),
  ALLOWED_ORIGINS: { ...list(), productionRequired: true },
  TRUSTED_PROXIES: list(),
  MAX_PROXY_HOPS: integer(1, 0, 16),
  HSTS_MAX_AGE: integer(31536000),
  DATABASE_URL: url(['postgres:', 'postgresql:'], true),
  DB_HOST: { ...hostname, default: 'localhost', aliases: ['DATABASE_HOST'] },
  DB_PORT: { ...integer(5432, 1, 65535), aliases: ['DATABASE_PORT'] },
  DB_USERNAME: { ...text({ default: 'postgres' }), aliases: ['DATABASE_USER'] },
  DB_PASSWORD: { ...secret(), aliases: ['DATABASE_PASSWORD'] },
  DB_DATABASE: {
    ...text({ default: 'truthbounty' }),
    aliases: ['DB_NAME', 'DATABASE_NAME'],
  },
  DB_SSL: { ...boolean(false), aliases: ['DATABASE_SSL'] },
  DATABASE_SSL_REJECT_UNAUTHORIZED: boolean(true),
  DATABASE_SYNCHRONIZE: boolean(false),
  DATABASE_LOGGING: boolean(false),
  SQLITE_PATH: {
    ...text({ default: 'database.sqlite' }),
    aliases: ['DATABASE_PATH'],
  },
  DB_POOL_MAX: integer(20, 1, 1000),
  DB_POOL_IDLE_TIMEOUT: integer(30000),
  DB_POOL_ACQUIRE_TIMEOUT: integer(60000),
  DB_POOL_RETRIES: integer(3, 0, 100),
  DB_POOL_RETRY_DELAY: integer(1000),
  REDIS_ENABLED: boolean(true),
  REDIS_HOST: { ...hostname, default: 'localhost', productionRequired: true },
  REDIS_PORT: integer(6379, 1, 65535),
  REDIS_PASSWORD: secret(true),
  REDIS_DB: integer(0, 0, 15),
  REDIS_TLS: boolean(false),
  CHAIN_ID: {
    ...integer(11155420),
    aliases: ['BLOCKCHAIN_CHAIN_ID', 'CONTRACT_RELEASE_CHAIN_ID'],
    productionRequired: true,
  },
  RPC_URL: {
    ...url(['https:', 'http:', 'wss:', 'ws:'], true),
    aliases: ['BLOCKCHAIN_RPC_URL', 'OPTIMISM_RPC_URL'],
  },
  BLOCKCHAIN_FALLBACK_RPC_URLS: list(),
  BLOCKCHAIN_RPC_TIMEOUT_MS: integer(10000),
  BLOCKCHAIN_STARTUP_VALIDATION: boolean(true),
  BLOCKCHAIN_STARTUP_RPC_CHECK: boolean(true),
  START_BLOCK: integer(0, 0),
  FINALITY_SAFE_CONFIRMATIONS: {
    ...integer(6),
    aliases: ['CONFIRMATIONS_SAFE', 'BLOCKCHAIN_CONFIRMATION_DEPTH'],
  },
  FINALITY_FINALIZED_CONFIRMATIONS: {
    ...integer(12),
    aliases: [
      'CONFIRMATIONS_FINALIZED',
      'CONFIRMATIONS_REQUIRED',
      'REQUIRED_CONFIRMATIONS',
    ],
  },
  CONFIRMATIONS_FULL: integer(64),
  FINALITY_ALLOWED_CHAIN_IDS: { ...list(), default: '10,11155420' },
  BLOCKCHAIN_MAX_BLOCKS: integer(10000),
  BLOCKCHAIN_MAX_EVENTS: integer(50000),
  BLOCKCHAIN_MAX_REORG_HISTORY: integer(1000),
  BLOCK_RANGE_PER_BATCH: integer(5000),
  MAX_RETRY_ATTEMPTS: integer(3, 0, 100),
  POLLING_INTERVAL_MS: integer(12000),
  MIN_BATCH_SIZE_FLOOR: integer(1),
  ADAPTIVE_FILL_THRESHOLD_BLOCKS: integer(10000),
  CONTRACT_RELEASE_MANIFEST_PATH: text({ productionRequired: true }),
  CONTRACT_RELEASE_ID: {
    ...text({ productionRequired: true }),
    aliases: ['RELEASE_ID'],
  },
  CONTRACT_RELEASE_SHA256: {
    ...text({ productionRequired: true }),
    description: '64-character lowercase SHA-256',
    parse(value: string) {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid checksum');
      return value;
    },
  },
  CONTRACT_RELEASE_DEPLOYMENT_BLOCK: {
    ...integer(0, 0),
    productionRequired: true,
  },
  CONTRACT_RELEASE_MAX_AGE_DAYS: {
    ...integer(90, 1, 365),
    aliases: ['MANIFEST_MAX_AGE_DAYS'],
  },
  CONTRACT_RELEASE_STRICT: boolean(true),
  IPFS_PROVIDER: choice(['local', 'pinata', 'web3storage'], 'local'),
  IPFS_LOCAL_STORAGE_PATH: text({ default: 'data/ipfs' }),
  IPFS_GATEWAY_URL: url(undefined, true),
  IPFS_API_URL: url(undefined, true),
  SMTP_HOST: { ...hostname, productionRequired: true },
  SMTP_PORT: integer(587, 1, 65535),
  SMTP_USER: secret(true),
  SMTP_PASSWORD: { ...secret(true), aliases: ['SMTP_PASS'] },
  SMTP_FROM: {
    ...text({ productionRequired: true }),
    aliases: ['EMAIL_FROM', 'NOTIFICATION_EMAIL_FROM'],
  },
  NOTIFICATION_QUEUE_DELAY: integer(0, 0),
  NOTIFICATION_MAX_RETRIES: integer(5, 0, 100),
  NOTIFICATION_RETRY_DELAY: integer(2000),
  AI_PROVIDER: choice(['openai', 'mock'], 'mock'),
  DEFAULT_LLM_PROVIDER: choice(['openai', 'anthropic'], 'openai'),
  OPENAI_API_KEY: secret(),
  ANTHROPIC_API_KEY: secret(),
  OPENAI_BASE_URL: { ...url(), default: 'https://api.openai.com/v1' },
  OPENAI_MODEL: text({ default: 'gpt-4o-mini' }),
  AI_MAX_PROMPT_LENGTH: integer(4000),
  AI_MEMORY_WINDOW_MESSAGES: integer(10),
  AI_MEMORY_WINDOW_TOKEN_BUDGET: integer(3000),
  AI_CONTEXT_TOP_N: integer(5),
  AI_CONTEXT_CACHE_TTL: integer(900),
  AI_CONVO_WINDOW_CACHE_TTL: integer(120),
  AI_PROVIDER_AVAILABILITY_CACHE_TTL: integer(30),
  AI_REDACT_BEFORE_STORE: boolean(true),
  LOG_LEVEL: choice(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
    'info',
  ),
  METRICS_TOKEN: secret(true),
  LOG_REDACT_RPC_URLS: boolean(true),
  JWT_SECRET: secret(true),
  JWT_EXPIRATION: { ...duration, default: '15m' },
  REFRESH_TOKEN_EXPIRATION: { ...duration, default: '7d' },
  SIWE_DOMAIN: text({ productionRequired: true }),
  IDEMPOTENCY_ENABLED: boolean(true),
  IDEMPOTENCY_TTL: integer(86400),
  IDEMPOTENCY_KEY_LENGTH: integer(32, 16, 256),
  RATE_LIMIT_CLAIMS_TTL: integer(60),
  RATE_LIMIT_CLAIMS_LIMIT: integer(5),
  RATE_LIMIT_VOTES_TTL: integer(60),
  RATE_LIMIT_VOTES_LIMIT: integer(20),
  RATE_LIMIT_DISPUTES_TTL: integer(60),
  RATE_LIMIT_DISPUTES_LIMIT: integer(3),
  RATE_LIMIT_AUTH_TTL: integer(60),
  RATE_LIMIT_AUTH_LIMIT: integer(5),
  RATE_LIMIT_AI_TTL: integer(60),
  RATE_LIMIT_AI_LIMIT: integer(10),
  RATE_LIMIT_AI_STREAM_TTL: integer(60),
  RATE_LIMIT_AI_STREAM_LIMIT: integer(3),
  RATE_LIMIT_DEFAULT_TTL: integer(60),
  RATE_LIMIT_DEFAULT_LIMIT: integer(10),
  REALTIME_POLL_INTERVAL_MS: integer(1000),
  REALTIME_MAX_PUBLISH_BATCH: integer(100),
  REALTIME_HEARTBEAT_INTERVAL_MS: integer(15000),
  REALTIME_MAX_BACKLOG: integer(1000),
  REALTIME_MAX_REPLAY_ROWS: integer(5000),
  RATE_LIMIT_CLAIMS_BLOCK_DURATION: optionalInteger(),
  RATE_LIMIT_VOTES_BLOCK_DURATION: optionalInteger(),
  RATE_LIMIT_DISPUTES_BLOCK_DURATION: optionalInteger(),
  RATE_LIMIT_AUTH_BLOCK_DURATION: optionalInteger(),
  RATE_LIMIT_AI_BLOCK_DURATION: optionalInteger(),
  RATE_LIMIT_AI_STREAM_BLOCK_DURATION: optionalInteger(),
  RATE_LIMIT_DEFAULT_BLOCK_DURATION: optionalInteger(),
  SYBIL_MIN_CLAIMS_FOR_ACCURACY_SCORE: integer(5),
  CACHE_CLAIMS_TTL: integer(300),
  CACHE_GOVERNANCE_TTL: integer(3600),
  CACHE_REPUTATION_TTL: integer(3600),
  CACHE_VERSION: text({ default: 'v1' }),
  AUTH_NONCE_TTL_MS: integer(300000),
  SIWE_ORIGIN: url(),
  SERVICE_API_KEY: secret(),
  ADMIN_WALLETS: list(),
  DATABASE_SEED: boolean(false),
  FINALITY_POLICY_STARTUP_VALIDATION: boolean(true),
  MANIFEST_VALIDATION: boolean(true),
  CONTRACT_ADDRESS_MANIFEST: text(),
  REWARD_CONTRACT_ADDRESS: address,
  CONTRACT_ADDRESS: address,
  TREASURY_ADDRESS: address,
  VERIFIER_ADDRESS: address,
  FEE_RECIPIENT: address,
  INDEXED_CONTRACTS: {
    description: 'JSON array of indexer contracts',
    default: '[]',
    parse(value: string) {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new Error('expected array');
      return JSON.stringify(parsed);
    },
  },
  NOTIFICATION_EMAIL_PROVIDER: choice(['smtp', 'sendgrid', 'mailgun'], 'smtp'),
  SENDGRID_API_KEY: secret(),
  MAILGUN_API_KEY: secret(),
  MAILGUN_DOMAIN: text(),
  FCM_PROJECT_ID: text(),
  FCM_SERVER_KEY: secret(),
  WEBHOOK_REQUIRE_HTTPS: boolean(true),
  WEBHOOK_TIMEOUT_MS: integer(10000),
  AUDIT_HASH_SECRET: secret(true),
  AUDIT_ARCHIVAL_BUCKET: text({ default: 'audit-archive' }),
  AUDIT_ARCHIVAL_ENABLED: boolean(false),
  AUDIT_ASYNC_WRITES_ENABLED: boolean(true),
  AUDIT_BATCH_SIZE: integer(50),
  AUDIT_LOG_RETENTION_CRON: text(),
  AUDIT_LOG_RETENTION_DAYS: integer(365),
  AUDIT_PII_RETENTION_DAYS: integer(30),
  AUDIT_MAX_BATCH_WAIT_MS: integer(1000),
  AUDIT_METRIC_PREFIX: text({ default: 'audit' }),
  AUDIT_MAX_API_CALLS: integer(100),
  AUDIT_MAX_FAILED_LOGINS: integer(5),
  AUDIT_MAX_PERMISSION_CHANGES: integer(3),
  AUDIT_SUSPICIOUS_WINDOW_MINUTES: integer(15),
  BACKUP_STORAGE_DIR: text({ default: '/var/backups/truthbounty-v2' }),
  REBUILD_SCHEMA: text(),
  MAINTENANCE_WINDOW_START: { ...clockTime, default: '02:00' },
  MAINTENANCE_WINDOW_END: { ...clockTime, default: '04:00' },
  WORLDCOIN_ACTION: text(),
  WORLDCOIN_APP_ID: text(),
  WORLDCOIN_VERIFY_BASE_URL: url(),
  CB_FAILURE_THRESHOLD_DATABASE: integer(5),
  CB_FAILURE_THRESHOLD_REDIS: integer(5),
  CB_FAILURE_THRESHOLD_RPC: integer(5),
  CB_FAILURE_THRESHOLD_IPFS: integer(5),
  CB_FAILURE_THRESHOLD_QUEUE: integer(5),
  CB_RESET_MS_DATABASE: integer(30000),
  CB_RESET_MS_REDIS: integer(30000),
  CB_RESET_MS_RPC: integer(30000),
  CB_RESET_MS_IPFS: integer(30000),
  CB_RESET_MS_QUEUE: integer(30000),
  DEPENDENCY_TIMEOUT_DATABASE: integer(5000, 0),
  DEPENDENCY_TIMEOUT_REDIS: integer(2000, 0),
  DEPENDENCY_TIMEOUT_RPC: integer(10000, 0),
  DEPENDENCY_TIMEOUT_IPFS: integer(15000, 0),
  DEPENDENCY_TIMEOUT_QUEUE: integer(5000, 0),
} as const satisfies Record<string, Field<unknown>>;

export type RuntimeConfig = Readonly<{
  [K in keyof typeof runtimeSchema]:
    ReturnType<(typeof runtimeSchema)[K]['parse']> | undefined;
}>;
export type Environment = Readonly<Record<string, string | undefined>>;

/** Errors contain schema keys and constraints only, never supplied values. */
export function parseRuntimeConfig(env: Environment): RuntimeConfig {
  const result: Record<string, unknown> = {};
  const errors: string[] = [];
  if (env.RELEASE_MANIFEST_MAX_AGE_MS !== undefined)
    errors.push(
      'RELEASE_MANIFEST_MAX_AGE_MS: replace with CONTRACT_RELEASE_MAX_AGE_DAYS',
    );
  if (
    env.CONTRACT_ADDRESS_MANIFEST !== undefined &&
    env.CONTRACT_RELEASE_MANIFEST_PATH !== undefined
  )
    errors.push(
      'CONTRACT_ADDRESS_MANIFEST: conflicts with canonical release manifest',
    );
  const deployed = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  for (const [key, definition] of Object.entries(runtimeSchema)) {
    const field: Field<unknown> = definition;
    const supplied = [key, ...(field.aliases ?? [])].filter(
      (name) => env[name] !== undefined,
    );
    if (supplied.length > 1)
      errors.push(`${key}: duplicate aliases (${supplied.join(', ')})`);
    const raw = supplied.length ? env[supplied[0]] : field.default;
    if (deployed && field.productionRequired && !supplied.length)
      errors.push(`${key}: required explicitly in staging/production`);
    if (raw === undefined) {
      result[key] = undefined;
      continue;
    }
    if (raw.trim() === '') {
      errors.push(`${key}: must not be empty`);
      continue;
    }
    try {
      result[key] = field.parse(field.secret ? raw : raw.trim());
    } catch {
      errors.push(`${key}: expected ${field.description}`);
    }
  }
  const config = result as RuntimeConfig;
  if (
    config.SIWE_SUPPORTED_CHAIN_IDS &&
    !config.SIWE_SUPPORTED_CHAIN_IDS.includes(String(config.CHAIN_ID))
  ) {
    errors.push('SIWE_SUPPORTED_CHAIN_IDS: must include the configured chain');
  }
  const bindingKeys = [
    'INDEXER_RELEASE_ID',
    'INDEXER_DEPLOYMENT_BLOCK',
    'INDEXER_ARTIFACT_CHECKSUM',
  ] as const;
  if (bindingKeys.some((key) => config[key] !== undefined)) {
    if (bindingKeys.some((key) => config[key] === undefined))
      errors.push('INDEXER_RELEASE_ID: complete release binding required');
    if (
      config.INDEXER_RELEASE_ID &&
      !/^[A-Za-z0-9._-]{1,64}$/.test(config.INDEXER_RELEASE_ID)
    )
      errors.push('INDEXER_RELEASE_ID: invalid release identifier');
    if (
      config.CONTRACT_RELEASE_ID &&
      config.INDEXER_RELEASE_ID !== config.CONTRACT_RELEASE_ID
    )
      errors.push('INDEXER_RELEASE_ID: conflicts with canonical release');
    if (
      config.CONTRACT_RELEASE_ID &&
      config.INDEXER_DEPLOYMENT_BLOCK !==
        config.CONTRACT_RELEASE_DEPLOYMENT_BLOCK
    )
      errors.push('INDEXER_DEPLOYMENT_BLOCK: conflicts with canonical release');
  }

  if (config.DATABASE_URL) {
    const componentKeys = [
      'DB_HOST',
      'DB_PORT',
      'DB_USERNAME',
      'DB_PASSWORD',
      'DB_DATABASE',
    ] as const;
    for (const key of componentKeys) {
      const names = [key, ...runtimeSchema[key].aliases];
      if (names.some((name) => env[name] !== undefined))
        errors.push(`${key}: cannot be combined with DATABASE_URL`);
    }
    try {
      const database = new URL(config.DATABASE_URL);
      // All consumers, including legacy indexer getters, see the URL's endpoint.
      result.DB_HOST = database.hostname;
      result.DB_PORT = database.port ? Number(database.port) : 5432;
      result.DB_USERNAME = decodeURIComponent(database.username);
      result.DB_PASSWORD = decodeURIComponent(database.password);
      result.DB_DATABASE = decodeURIComponent(database.pathname.slice(1));
      if (!result.DB_USERNAME || !result.DB_DATABASE)
        errors.push('DATABASE_URL: username and database are required');
    } catch {
      errors.push('DATABASE_URL: malformed connection settings');
    }
  }
  for (const endpoint of config.BLOCKCHAIN_FALLBACK_RPC_URLS ?? []) {
    try {
      url(['https:', 'http:', 'wss:', 'ws:']).parse(endpoint);
    } catch {
      errors.push('BLOCKCHAIN_FALLBACK_RPC_URLS: invalid URL');
    }
    if (deployed && !/^(https|wss):/.test(endpoint))
      errors.push('BLOCKCHAIN_FALLBACK_RPC_URLS: secure transport required');
  }
  for (const origin of config.ALLOWED_ORIGINS ?? []) {
    if (origin === '*' && !deployed) continue;
    try {
      const parsed = new URL(origin);
      if (
        !['https:', 'http:'].includes(parsed.protocol) ||
        parsed.origin !== origin ||
        (deployed && parsed.protocol !== 'https:')
      )
        throw new Error();
    } catch {
      errors.push(
        'ALLOWED_ORIGINS: expected HTTP origins (HTTPS when deployed)',
      );
    }
  }
  if (![10, 11155420].includes(config.CHAIN_ID ?? 0))
    errors.push('CHAIN_ID: only Optimism mainnet/Sepolia supported');
  if (
    (config.FINALITY_SAFE_CONFIRMATIONS ?? 0) >
      (config.FINALITY_FINALIZED_CONFIRMATIONS ?? 0) ||
    (config.FINALITY_FINALIZED_CONFIRMATIONS ?? 0) >
      (config.CONFIRMATIONS_FULL ?? 0)
  )
    errors.push('FINALITY_SAFE_CONFIRMATIONS: thresholds must be ordered');
  if (
    config.FINALITY_ALLOWED_CHAIN_IDS?.some(
      (id) => !['10', '11155420'].includes(id),
    ) ||
    !config.FINALITY_ALLOWED_CHAIN_IDS?.includes(String(config.CHAIN_ID))
  )
    errors.push(
      'FINALITY_ALLOWED_CHAIN_IDS: must include configured Optimism chain',
    );
  if (config.JWT_SECRET !== undefined && config.JWT_SECRET.length < 32)
    errors.push('JWT_SECRET: at least 32 characters required');
  if (deployed) {
    for (const key of [
      'LOCAL_DEV_MODE',
      'DATABASE_SYNCHRONIZE',
      'DATABASE_SEED',
    ] as const) {
      if (config[key]) errors.push(`${key}: forbidden in staging/production`);
    }
    for (const key of [
      'DB_SSL',
      'DATABASE_SSL_REJECT_UNAUTHORIZED',
      'REDIS_ENABLED',
      'REDIS_TLS',
      'BLOCKCHAIN_STARTUP_VALIDATION',
      'BLOCKCHAIN_STARTUP_RPC_CHECK',
      'CONTRACT_RELEASE_STRICT',
      'LOG_REDACT_RPC_URLS',
      'IDEMPOTENCY_ENABLED',
      'MANIFEST_VALIDATION',
      'FINALITY_POLICY_STARTUP_VALIDATION',
      'WEBHOOK_REQUIRE_HTTPS',
      'AI_REDACT_BEFORE_STORE',
    ] as const) {
      if (!config[key])
        errors.push(`${key}: must be true in staging/production`);
    }
    if (config.IPFS_PROVIDER === 'local')
      errors.push(
        'IPFS_PROVIDER: local storage forbidden in staging/production',
      );
    if (config.AI_PROVIDER === 'mock')
      errors.push('AI_PROVIDER: mock forbidden in staging/production');
    if (config.AI_PROVIDER === 'openai' && !config.OPENAI_API_KEY)
      errors.push('OPENAI_API_KEY: required for AI_PROVIDER');
    if (config.CONTRACT_ADDRESS_MANIFEST)
      errors.push(
        'CONTRACT_ADDRESS_MANIFEST: migrate to pinned canonical release',
      );
    if (
      config.DATABASE_URL &&
      /[?&]sslmode=(disable|allow|prefer|no-verify)(?:&|$)/i.test(
        config.DATABASE_URL,
      )
    )
      errors.push('DATABASE_URL: insecure TLS option forbidden');
    for (const [key, definition] of Object.entries(runtimeSchema)) {
      const value = result[key];
      if (
        typeof value === 'string' &&
        (definition as Field<unknown>).productionRequired &&
        /(?:localhost|127\.0\.0\.1|\[::1\]|your[-_]|changeme|placeholder|example\.com|^(?:password|secret|test|dummy)$)/i.test(
          value,
        )
      )
        errors.push(`${key}: development placeholder forbidden`);
    }
    for (const key of [
      'RPC_URL',
      'IPFS_GATEWAY_URL',
      'IPFS_API_URL',
    ] as const) {
      if (config[key] && !/^(https|wss):/.test(config[key]))
        errors.push(`${key}: secure transport required`);
    }
    if (config.ALLOWED_ORIGINS?.includes('*'))
      errors.push('ALLOWED_ORIGINS: wildcard forbidden in staging/production');
  }
  if (errors.length)
    throw new Error(`Invalid runtime configuration:\n${errors.join('\n')}`);
  return Object.freeze(config);
}

/** Legacy consumers receive normalized strings from the same immutable snapshot. */
export function compatibilityEnvironment(config: RuntimeConfig): Environment {
  const values: Record<string, string | undefined> = {};
  for (const [key, definition] of Object.entries(runtimeSchema)) {
    const value = config[key as keyof RuntimeConfig];
    const serialized =
      value === undefined
        ? undefined
        : Array.isArray(value)
          ? value.join(',')
          : String(value);
    for (const name of [key, ...((definition as Field<unknown>).aliases ?? [])])
      values[name] = serialized;
  }
  values.RELEASE_MANIFEST_MAX_AGE_MS = String(
    (config.CONTRACT_RELEASE_MAX_AGE_DAYS ?? 90) * 86400000,
  );
  values.SIWE_SUPPORTED_CHAIN_IDS ??= String(config.CHAIN_ID);
  values.SIWE_ALLOWED_DOMAINS ??= config.SIWE_DOMAIN;
  values.SIWE_ALLOWED_ORIGINS ??= config.ALLOWED_ORIGINS?.join(',');
  return Object.freeze(values);
}

export function runtimeConfigSummary(
  config: RuntimeConfig,
): Readonly<Record<string, string>> {
  // Even non-secret values may carry user-controlled data. Only report presence.
  return Object.freeze(
    Object.fromEntries(
      Object.entries(config).map(([key, value]) => [
        key,
        value === undefined ? 'unset' : '[REDACTED]',
      ]),
    ),
  );
}
