describe('Nest runtime configuration boundary', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
  });

  it('provides parsed numbers and a stable snapshot after environment mutation', async () => {
    process.env = {
      NODE_ENV: 'test',
      PORT: '4200',
      REDIS_PORT: '6380',
      JWT_SECRET: ' private secret with surrounding spaces ',
      BLOCKCHAIN_CHAIN_ID: '10',
      FINALITY_SAFE_CONFIRMATIONS: '4',
      FINALITY_FINALIZED_CONFIRMATIONS: '9',
      RATE_LIMIT_CLAIMS_TTL: '17',
    };
    await jest.isolateModulesAsync(async () => {
      const { Test } = await import('@nestjs/testing');
      const { ConfigModule, ConfigService } = await import('@nestjs/config');
      const { getNestRuntimeConfig, getRuntimeConfig, getRuntimeEnvironment } =
        await import('./runtime-config');
      const { default: blockchain } = await import('./blockchain.config');
      const { default: finality } = await import('./finality-policy.config');
      const { default: throttler } = await import('./throttler.config');
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            skipProcessEnv: true,
            validate: getNestRuntimeConfig,
            load: [blockchain, finality, throttler],
          }),
        ],
      }).compile();
      try {
        const service = module.get(ConfigService);
        expect(service.get('PORT')).toBe(4200);
        expect(service.get('REDIS_PORT')).toBe(6380);
        expect(service.get('REDIS_TLS')).toBe('false');
        expect(service.get('JWT_SECRET')).toBe(
          ' private secret with surrounding spaces ',
        );
        expect(service.get('blockchain.chainId')).toBe(10);
        expect(service.get('finalityPolicy.chainId')).toBe(10);
        expect(service.get('blockchain.confirmations.safe')).toBe(4);
        expect(service.get('finalityPolicy.safeConfirmations')).toBe(4);
        expect(service.get('throttler.claims')).toEqual({
          ttl: 17000,
          limit: 5,
          blockDuration: 17000,
        });
        const first = getRuntimeConfig();
        process.env.PORT = '9999';
        expect(getRuntimeConfig()).toBe(first);
        expect(service.get('PORT')).toBe(4200);
        expect(getRuntimeEnvironment().PORT).toBe('4200');
        expect(Object.isFrozen(first)).toBe(true);
      } finally {
        await module.close();
      }
    });
  });

  it('supplies new configuration loaders from the same frozen snapshot', async () => {
    process.env = {
      NODE_ENV: 'test',
      PUBLIC_STATUS_RATE_LIMIT: '17',
      ABUSE_SIGNALS_SCRAPE_MAX_READS: '42',
      INDEXER_RELEASE_ID: 'release-v1',
      INDEXER_DEPLOYMENT_BLOCK: '12',
      INDEXER_ARTIFACT_CHECKSUM: 'a'.repeat(64),
    };
    await jest.isolateModulesAsync(async () => {
      const { loadPublicStatusOptions } =
        await import('../health/public-status/public-status.options');
      const { loadAbusePolicyConfig } =
        await import('../abuse-signals/abuse-signals.config');
      const { loadFinalizedCursorConfig } =
        await import('../indexer/finalized-cursor/finalized-cursor.config');
      expect(loadPublicStatusOptions().rateLimit).toBe(17);
      process.env.PUBLIC_STATUS_RATE_LIMIT = '99';
      process.env.ABUSE_SIGNALS_SCRAPE_MAX_READS = '99';
      process.env.INDEXER_RELEASE_ID = 'another-release';
      expect(loadPublicStatusOptions().rateLimit).toBe(17);
      expect(
        loadAbusePolicyConfig().thresholds.scraping.maxAnonymousReads,
      ).toBe(42);
      expect(loadFinalizedCursorConfig().binding?.releaseId).toBe('release-v1');
    });
  });

  it('does not retain unrelated process credentials', async () => {
    process.env = { NODE_ENV: 'test', UNRELATED_SECRET: 'canary' };
    await jest.isolateModulesAsync(async () => {
      const { getRuntimeEnvironment } = await import('./runtime-config');
      expect(getRuntimeEnvironment()).not.toHaveProperty('UNRELATED_SECRET');
    });
  });
});
