import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaimReadModelProvenanceService } from './claim-read-model-provenance.service';

function configFrom(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
  } as unknown as ConfigService;
}

const VALID = {
  CLAIM_READ_MODEL_CHAIN_ID: 11155420,
  CLAIM_READ_MODEL_RELEASE_ID: 'rel-opsepolia-20261015-v2',
  CLAIM_READ_MODEL_DEPLOYMENT_BLOCK: 24850000,
  CLAIM_READ_MODEL_ARTIFACT_CHECKSUM: 'F'.repeat(64),
};

describe('ClaimReadModelProvenanceService', () => {
  it('resolves the release from the explicit override keys', () => {
    const provenance = new ClaimReadModelProvenanceService(
      configFrom(VALID),
    ).resolve();

    expect(provenance).toEqual({
      chainId: 11155420,
      releaseId: 'rel-opsepolia-20261015-v2',
      deploymentBlock: 24850000,
      artifactChecksum: 'f'.repeat(64),
    });
  });

  it('falls back to the generic release keys', () => {
    const provenance = new ClaimReadModelProvenanceService(
      configFrom({
        CHAIN_ID: 11155420,
        RELEASE_ID: 'rel-opsepolia-20261015-v2',
        DEPLOYMENT_BLOCK: 24850000,
        ARTIFACT_CHECKSUM: '0x' + 'a'.repeat(64),
      }),
    ).resolve();

    expect(provenance.releaseId).toBe('rel-opsepolia-20261015-v2');
    expect(provenance.artifactChecksum).toBe('a'.repeat(64));
  });

  it('fails closed when the release id is missing', () => {
    const rest: Record<string, unknown> = { ...VALID };
    delete rest.CLAIM_READ_MODEL_RELEASE_ID;
    try {
      new ClaimReadModelProvenanceService(configFrom(rest)).resolve();
      throw new Error('expected fail-closed');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const exception = err as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = exception.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('STALE_RECONCILIATION');
      expect(body.failClosed).toBe(true);
      expect(String(body.reason)).toContain('_missing');
      expect(body.provenance).toBeNull();
    }
  });

  it('fails closed on a malformed artifact checksum', () => {
    expect(() =>
      new ClaimReadModelProvenanceService(
        configFrom({ ...VALID, CLAIM_READ_MODEL_ARTIFACT_CHECKSUM: 'nope' }),
      ).resolve(),
    ).toThrow(HttpException);
  });

  it('fails closed on a non-positive chain id', () => {
    expect(() =>
      new ClaimReadModelProvenanceService(
        configFrom({ ...VALID, CLAIM_READ_MODEL_CHAIN_ID: 0 }),
      ).resolve(),
    ).toThrow(HttpException);
  });
});
