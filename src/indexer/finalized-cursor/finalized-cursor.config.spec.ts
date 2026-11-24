import { loadFinalizedCursorConfig } from './finalized-cursor.config';

describe('loadFinalizedCursorConfig', () => {
  const full = {
    BLOCKCHAIN_CHAIN_ID: '11155420',
    INDEXER_RELEASE_ID: 'v2.0.0-sepolia',
    INDEXER_DEPLOYMENT_BLOCK: '18000000',
    INDEXER_ARTIFACT_CHECKSUM: 'A'.repeat(64),
  };

  it('returns no binding when nothing is configured', () => {
    const config = loadFinalizedCursorConfig({});
    expect(config.binding).toBeNull();
    expect(config.policy).toEqual({
      maxIndexLagBlocks: 150,
      maxHeadAgeMs: 120_000,
    });
  });

  it('parses a complete binding and normalizes the checksum', () => {
    const config = loadFinalizedCursorConfig({
      ...full,
      INDEXER_MAX_FINALIZED_LAG_BLOCKS: '20',
      INDEXER_MAX_HEAD_AGE_SECONDS: '30',
    });
    expect(config.binding).toEqual({
      chainId: 11155420,
      releaseId: 'v2.0.0-sepolia',
      deploymentBlock: 18000000n,
      artifactChecksum: 'a'.repeat(64),
    });
    expect(config.policy).toEqual({
      maxIndexLagBlocks: 20,
      maxHeadAgeMs: 30_000,
    });
  });

  it.each([
    ['partial binding', { INDEXER_RELEASE_ID: 'v2' }],
    ['missing chain id', { ...full, BLOCKCHAIN_CHAIN_ID: undefined }],
    ['bad deployment block', { ...full, INDEXER_DEPLOYMENT_BLOCK: '-1' }],
    ['bad checksum', { ...full, INDEXER_ARTIFACT_CHECKSUM: 'xyz' }],
    ['bad release id', { ...full, INDEXER_RELEASE_ID: 'v2 with spaces' }],
    ['bad policy', { INDEXER_MAX_HEAD_AGE_SECONDS: 'soon' }],
  ])('fails closed on %s', (_label, env) => {
    expect(() => loadFinalizedCursorConfig(env as NodeJS.ProcessEnv)).toThrow();
  });
});
