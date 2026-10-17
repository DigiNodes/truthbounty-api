import { createHash } from 'node:crypto';
import { createRuntimeSnapshot, parseEnvironmentFile } from './runtime-config';
import {
  compatibilityEnvironment,
  parseRuntimeConfig,
  runtimeConfigSummary,
  runtimeSchema,
  Field,
} from './runtime-schema';

const release = Buffer.from(
  JSON.stringify({
    chainId: 11155420,
    releaseId: 'op-test-v1',
    deploymentBlock: 12,
  }),
);
const pinned = {
  CONTRACT_RELEASE_MANIFEST_PATH: 'release.json',
  CONTRACT_RELEASE_SHA256: createHash('sha256').update(release).digest('hex'),
  CONTRACT_RELEASE_ID: 'op-test-v1',
  CONTRACT_RELEASE_DEPLOYMENT_BLOCK: '12',
};
const production = {
  ...pinned,
  NODE_ENV: 'production',
  CHAIN_ID: '11155420',
  DATABASE_URL: 'postgresql://app:secret@db.internal/truthbounty',
  DB_SSL: 'true',
  REDIS_HOST: 'redis.internal',
  REDIS_PASSWORD: 'redis-credential',
  REDIS_TLS: 'true',
  RPC_URL: 'https://rpc.internal/private-key',
  JWT_SECRET: 'a-distinct-long-secret-for-this-unit-test',
  CAPABILITY_TOKEN_SIGNING_KEY: 'a-distinct-capability-key-for-this-unit-test',
  SIWE_DOMAIN: 'truthbounty.internal',
  ALLOWED_ORIGINS: 'https://app.internal',
  IPFS_PROVIDER: 'pinata',
  IPFS_GATEWAY_URL: 'https://ipfs.internal',
  IPFS_API_URL: 'https://ipfs.internal/api',
  SMTP_HOST: 'smtp.internal',
  SMTP_USER: 'mailer',
  SMTP_PASSWORD: 'mail-credential',
  SMTP_FROM: 'mail@app.internal',
  METRICS_TOKEN: 'metrics-credential',
  AUDIT_HASH_SECRET: 'audit-credential',
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'openai-credential',
};

describe('runtime schema', () => {
  it('uses canonical chain, domain and origins for omitted SIWE overrides', () => {
    const environment = compatibilityEnvironment(
      parseRuntimeConfig({
        CHAIN_ID: '11155420',
        SIWE_DOMAIN: 'app.internal',
        ALLOWED_ORIGINS: 'https://app.internal',
      }),
    );
    expect(environment.SIWE_SUPPORTED_CHAIN_IDS).toBe('11155420');
    expect(environment.SIWE_ALLOWED_DOMAINS).toBe('app.internal');
    expect(environment.SIWE_ALLOWED_ORIGINS).toBe('https://app.internal');
    expect(() =>
      parseRuntimeConfig({
        CHAIN_ID: '11155420',
        SIWE_SUPPORTED_CHAIN_IDS: '10',
      }),
    ).toThrow('configured chain');
    expect(() =>
      parseRuntimeConfig({ SIWE_SUPPORTED_CHAIN_IDS: 'NaN' }),
    ).toThrow('SIWE_SUPPORTED_CHAIN_IDS');
  });
  it('keeps finalized-cursor artifact checksums distinct from manifest checksums', () => {
    const config = parseRuntimeConfig({
      ...pinned,
      INDEXER_RELEASE_ID: 'op-test-v1',
      INDEXER_DEPLOYMENT_BLOCK: '12',
      INDEXER_ARTIFACT_CHECKSUM: 'a'.repeat(64),
    });
    expect(config.INDEXER_ARTIFACT_CHECKSUM).toBe('a'.repeat(64));
    expect(config.CONTRACT_RELEASE_SHA256).toBe(pinned.CONTRACT_RELEASE_SHA256);
    expect(compatibilityEnvironment(config).RELEASE_ID).toBe('op-test-v1');
  });

  it.each([
    { INDEXER_RELEASE_ID: 'other-release' },
    { INDEXER_DEPLOYMENT_BLOCK: '13' },
    { INDEXER_ARTIFACT_CHECKSUM: undefined },
  ])(
    'rejects incomplete or conflicting finalized-cursor binding %j',
    (override) => {
      expect(() =>
        parseRuntimeConfig({
          ...pinned,
          INDEXER_RELEASE_ID: 'op-test-v1',
          INDEXER_DEPLOYMENT_BLOCK: '12',
          INDEXER_ARTIFACT_CHECKSUM: 'a'.repeat(64),
          ...override,
        }),
      ).toThrow(/INDEXER_/);
    },
  );

  it.each([
    ['PUBLIC_STATUS_RATE_LIMIT', '0'],
    ['OPERATIONS_AUDIT_MAX', 'NaN'],
    ['ABUSE_SIGNALS_ENABLED', 'yes'],
    ['ABUSE_SIGNALS_WINDOW_SECONDS', '1.5'],
    ['ABUSE_SIGNALS_TRUSTED_PROXY_HOPS', '-1'],
    ['ABUSE_SIGNALS_SUBJECT_SALT', 'private-short-secret'],
  ])(
    'validates newly integrated setting %s without disclosing its value',
    (key, value) => {
      expect(() => parseRuntimeConfig({ [key]: value })).toThrow(key);
      try {
        parseRuntimeConfig({ [key]: value });
      } catch (error) {
        if (value === 'private-short-secret')
          expect(String(error)).not.toContain(value);
      }
    },
  );

  it('derives legacy database components from the one canonical URL', () => {
    const config = parseRuntimeConfig({
      DATABASE_URL:
        'postgresql://app:encoded%40secret@db.internal:5433/truthbounty',
    });
    expect(config.DB_HOST).toBe('db.internal');
    expect(config.DB_PORT).toBe(5433);
    expect(config.DB_PASSWORD).toBe('encoded@secret');
    expect(config.DB_DATABASE).toBe('truthbounty');
    expect(() =>
      parseRuntimeConfig({
        DATABASE_URL: 'postgresql://app:pass@db.internal/db',
        DB_HOST: 'another.internal',
      }),
    ).toThrow('cannot be combined');
  });
  it.each(
    Object.entries(runtimeSchema)
      .filter(([, field]) => (field as Field<unknown>).productionRequired)
      .map(([key]) => key),
  )('requires production field %s', (key) => {
    const env: Record<string, string> = { ...production };
    delete env[key];
    expect(() => parseRuntimeConfig(env)).toThrow(
      `${key}: required explicitly`,
    );
  });
  it.each([
    ['REDIS_HOST', 'user:password@host'],
    ['DB_PORT', '5432oops'],
    ['SMTP_PORT', '0'],
    ['RPC_URL', 'javascript:credential'],
    ['IPFS_API_URL', 'not-a-url'],
    ['CONTRACT_ADDRESS', '0x0000000000000000000000000000000000000000'],
    ['CONTRACT_RELEASE_SHA256', 'not-a-checksum'],
    ['LOG_LEVEL', 'anything'],
    ['RATE_LIMIT_AUTH_LIMIT', '0'],
    ['REALTIME_MAX_BACKLOG', '-1'],
    ['MAINTENANCE_WINDOW_START', '25:70'],
    ['JWT_EXPIRATION', 'forever'],
  ])('rejects malformed boundary value %s', (key, value) => {
    expect(() => parseRuntimeConfig({ [key]: value })).toThrow(key);
  });
  it('parses typed primitives and freezes nested lists', () => {
    const config = parseRuntimeConfig({
      PORT: '8080',
      REDIS_TLS: 'true',
      ALLOWED_ORIGINS: 'https://a.internal,https://b.internal',
    });
    expect(config.PORT).toBe(8080);
    expect(config.REDIS_TLS).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.ALLOWED_ORIGINS)).toBe(true);
    expect(() => {
      (config as { PORT: number }).PORT = 9999;
    }).toThrow();
  });
  it.each(['', ' ', '3seconds', '-1', '1.1', '0', '65536', 'Infinity'])(
    'rejects malformed port %j',
    (PORT) => {
      expect(() => parseRuntimeConfig({ PORT })).toThrow('PORT');
    },
  );
  it.each(['yes', '1', 'FALSE', ''])(
    'rejects ambiguous boolean %j',
    (REDIS_TLS) => {
      expect(() => parseRuntimeConfig({ REDIS_TLS })).toThrow('REDIS_TLS');
    },
  );
  it.each(
    Object.entries(runtimeSchema).flatMap(([key, field]) =>
      ((field as Field<unknown>).aliases ?? []).map((alias) => [key, alias]),
    ),
  )('rejects duplicate aliases: %s / %s', (key, alias) => {
    expect(() =>
      parseRuntimeConfig({ [key]: 'same-value', [alias]: 'same-value' }),
    ).toThrow('duplicate aliases');
  });
  it('normalizes a legacy alias for every consumer', () => {
    const config = parseRuntimeConfig({
      BLOCKCHAIN_CHAIN_ID: '10',
      OPTIMISM_RPC_URL: 'https://rpc.internal',
      SMTP_PASS: 'secret',
    });
    const env = compatibilityEnvironment(config);
    expect(config.CHAIN_ID).toBe(10);
    expect(env.CHAIN_ID).toBe(env.BLOCKCHAIN_CHAIN_ID);
    expect(env.RPC_URL).toBe(env.BLOCKCHAIN_RPC_URL);
    expect(env.SMTP_PASSWORD).toBe(env.SMTP_PASS);
    expect(Object.isFrozen(env)).toBe(true);
  });
  it('requires explicit deployed settings instead of local defaults', () => {
    expect(() => parseRuntimeConfig({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL: required explicitly',
    );
    expect(() => parseRuntimeConfig({ NODE_ENV: 'staging' })).toThrow(
      'CHAIN_ID: required explicitly',
    );
    expect(() => parseRuntimeConfig(production)).not.toThrow();
  });
  it.each([
    ['LOCAL_DEV_MODE', 'true'],
    ['DATABASE_SYNCHRONIZE', 'true'],
    ['DATABASE_SEED', 'true'],
    ['REDIS_ENABLED', 'false'],
    ['REDIS_TLS', 'false'],
    ['DB_SSL', 'false'],
    ['DATABASE_SSL_REJECT_UNAUTHORIZED', 'false'],
    ['BLOCKCHAIN_STARTUP_RPC_CHECK', 'false'],
    ['BLOCKCHAIN_STARTUP_VALIDATION', 'false'],
    ['CONTRACT_RELEASE_STRICT', 'false'],
    ['IPFS_PROVIDER', 'local'],
    ['AI_PROVIDER', 'mock'],
    ['ALLOWED_ORIGINS', '*'],
    ['RPC_URL', 'http://rpc.internal'],
    ['JWT_SECRET', 'short'],
    ['SMTP_HOST', 'localhost'],
  ])('rejects unsafe production %s', (key, value) => {
    expect(() => parseRuntimeConfig({ ...production, [key]: value })).toThrow(
      key,
    );
  });
  it.each(['1', '137', '10oops'])(
    'rejects wrong or malformed chain %s',
    (CHAIN_ID) => {
      expect(() => parseRuntimeConfig({ CHAIN_ID })).toThrow('CHAIN_ID');
    },
  );
  it('rejects inconsistent finality thresholds and chain allowlists', () => {
    expect(() =>
      parseRuntimeConfig({ FINALITY_SAFE_CONFIRMATIONS: '13' }),
    ).toThrow('thresholds');
    expect(() =>
      parseRuntimeConfig({ FINALITY_ALLOWED_CHAIN_IDS: '10' }),
    ).toThrow('FINALITY_ALLOWED_CHAIN_IDS');
  });
  it('does not leak values in errors or health summaries', () => {
    const canary = 'credential-canary-do-not-log';
    try {
      parseRuntimeConfig({ PORT: canary, RPC_URL: canary });
      throw new Error('expected failure');
    } catch (error) {
      expect(String(error)).toContain('PORT');
      expect(String(error)).not.toContain(canary);
    }
    const summary = JSON.stringify(
      runtimeConfigSummary(
        parseRuntimeConfig({
          JWT_SECRET: canary.repeat(2),
          RPC_URL: `https://user:${canary}@rpc.internal/${canary}`,
        }),
      ),
    );
    expect(summary).not.toContain(canary);
    expect(summary).toContain('[REDACTED]');
  });
});

describe('startup snapshot', () => {
  it('rejects duplicate file definitions including export assignments', () => {
    expect(() => parseEnvironmentFile('PORT=3000\nexport PORT=3001')).toThrow(
      'Duplicate environment variable: PORT',
    );
    expect(
      parseEnvironmentFile('NOTE="line1\nPORT=4000"\nPORT=3000').PORT,
    ).toBe('3000');
  });
  it('uses process > local > default precedence without mutating the source', () => {
    const env = { PORT: '4000' };
    const snapshot = createRuntimeSnapshot(env, [
      'PORT=3001\nLOG_LEVEL=warn',
      'PORT=3000\nLOG_LEVEL=debug',
    ]);
    expect(snapshot.config.PORT).toBe(4000);
    expect(snapshot.config.LOG_LEVEL).toBe('warn');
    env.PORT = '9000';
    expect(snapshot.config.PORT).toBe(4000);
    expect(snapshot.environment.PORT).toBe('4000');
  });
  it('detects aliases across file/process boundaries', () => {
    expect(() =>
      createRuntimeSnapshot({ CHAIN_ID: '10' }, ['BLOCKCHAIN_CHAIN_ID=10']),
    ).toThrow('duplicate aliases');
  });
  it('validates before reading a manifest', () => {
    const read = jest.fn();
    expect(() =>
      createRuntimeSnapshot({ ...pinned, PORT: 'bad' }, [], read),
    ).toThrow('PORT');
    expect(read).not.toHaveBeenCalled();
  });
  it('accepts a pinned matching release', () => {
    const read = jest.fn(() => release);
    const snapshot = createRuntimeSnapshot(production, [], read);
    expect(snapshot.config.CONTRACT_RELEASE_ID).toBe('op-test-v1');
    expect(read).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(snapshot.environment)).toBe(true);
  });
  it.each([
    { CONTRACT_RELEASE_ID: 'wrong-release' },
    { CHAIN_ID: '10' },
    { CONTRACT_RELEASE_DEPLOYMENT_BLOCK: '13' },
    { CONTRACT_RELEASE_SHA256: 'f'.repeat(64) },
  ])('rejects incompatible release binding %j', (override) => {
    expect(() =>
      createRuntimeSnapshot({ ...pinned, ...override }, [], () => release),
    ).toThrow('incompatible release');
  });
  it('redacts filesystem errors and rejects malformed manifests', () => {
    expect(() =>
      createRuntimeSnapshot(pinned, [], () => {
        throw new Error('secret-path');
      }),
    ).toThrow('unreadable');
    try {
      createRuntimeSnapshot(pinned, [], () => {
        throw new Error('secret-path');
      });
    } catch (error) {
      expect(String(error)).not.toContain('secret-path');
    }
    const bytes = Buffer.from('private invalid json');
    expect(() =>
      createRuntimeSnapshot(
        {
          ...pinned,
          CONTRACT_RELEASE_SHA256: createHash('sha256')
            .update(bytes)
            .digest('hex'),
        },
        [],
        () => bytes,
      ),
    ).toThrow('malformed');
  });
});
