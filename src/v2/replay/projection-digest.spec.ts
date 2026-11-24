import {
  canonicalizeValue,
  compareProjectionDigests,
  digestProjector,
  MissingProjectionDigestError,
  normalizeNumericValue,
  ProjectionBindingMismatchError,
  ProjectionDigestMismatchError,
  stableStringify,
} from './projection-digest';
import { ProjectionDigest } from './projection-rebuild.types';

describe('Canonical Projection Digests (PREWAVE-BE-039)', () => {
  const baseContext = {
    schema: 'replay_shadow',
    releaseId: 'v2.1.0-alpha',
    chainId: 11155420,
    deploymentBlock: 12000,
    artifactChecksum: '0xfa34bc567890abcdef',
  };

  describe('1. Identical data / different insertion order', () => {
    it('produces identical dataDigest and envelopeDigest regardless of insertion order', async () => {
      const row1 = { claimId: 'c-101', amount: '500', verdict: 'VALID' };
      const row2 = { claimId: 'c-102', amount: '250', verdict: 'INVALID' };
      const row3 = { claimId: 'c-103', amount: '1000', verdict: 'VALID' };
      const row4 = { claimId: 'c-104', amount: '75', verdict: 'DISPUTED' };

      const rowsA = [row1, row2, row3, row4];
      const rowsB = [row4, row2, row1, row3];
      const rowsC = [row3, row1, row4, row2];

      const digestA = await digestProjector('disputes', rowsA, baseContext);
      const digestB = await digestProjector('disputes', rowsB, baseContext);
      const digestC = await digestProjector('disputes', rowsC, baseContext);

      expect(digestA.digest).toBe(digestB.digest);
      expect(digestB.digest).toBe(digestC.digest);
      expect(digestA.envelopeDigest).toBe(digestB.envelopeDigest);
      expect(digestA.rowCount).toBe(4);
      expect(digestB.rowCount).toBe(4);
    });

    it('object key insertion order within a row does not affect digest', async () => {
      const rowA = { a: 1, b: 2, c: 3 };
      const rowB = { c: 3, a: 1, b: 2 };

      const digestA = await digestProjector('test', [rowA], baseContext);
      const digestB = await digestProjector('test', [rowB], baseContext);

      expect(digestA.digest).toBe(digestB.digest);
    });
  });

  describe('2. Timezone equivalence', () => {
    it('normalizes Date objects and different ISO 8601 timezone offsets to identical digests', async () => {
      // All these strings represent 2026-10-17T11:00:00.000Z in different timezone notations
      const instantUTC = '2026-10-17T11:00:00.000Z';
      const instantUTCNoMs = '2026-10-17T11:00:00Z';
      const instantPlus1 = '2026-10-17T12:00:00+01:00';
      const instantMinus4 = '2026-10-17T07:00:00-04:00';
      const dateObj = new Date(instantUTC);

      const rowsEnv1 = [
        { id: 'tx-1', timestamp: instantUTC, note: 'event 1' },
        { id: 'tx-2', timestamp: instantPlus1, note: 'event 2' },
      ];

      const rowsEnv2 = [
        { id: 'tx-1', timestamp: instantUTCNoMs, note: 'event 1' },
        { id: 'tx-2', timestamp: dateObj, note: 'event 2' },
      ];

      const rowsEnv3 = [
        { id: 'tx-1', timestamp: instantMinus4, note: 'event 1' },
        { id: 'tx-2', timestamp: instantPlus1, note: 'event 2' },
      ];

      const d1 = await digestProjector('claims', rowsEnv1, baseContext);
      const d2 = await digestProjector('claims', rowsEnv2, baseContext);
      const d3 = await digestProjector('claims', rowsEnv3, baseContext);

      expect(d1.digest).toBe(d2.digest);
      expect(d2.digest).toBe(d3.digest);
    });
  });

  describe('3. Numeric precision and representation', () => {
    it('normalizes integer vs float representations and trailing decimal zeroes', async () => {
      const rows1 = [
        { balance: '100.00', score: 10, ratio: '0.5000' },
        { balance: '250.50', score: 20.0, ratio: '1.250' },
      ];

      const rows2 = [
        { balance: '100', score: 10.0, ratio: '0.5' },
        { balance: '250.5', score: 20, ratio: '1.25' },
      ];

      const d1 = await digestProjector('balances', rows1, baseContext);
      const d2 = await digestProjector('balances', rows2, baseContext);

      expect(d1.digest).toBe(d2.digest);
    });

    it('normalizes exponential scientific notation and BigInt', async () => {
      const rows1 = [{ amount: '1e4', big: 1000n }];
      const rows2 = [{ amount: '10000', big: '1000' }];

      const d1 = await digestProjector('treasury', rows1, baseContext);
      const d2 = await digestProjector('treasury', rows2, baseContext);

      expect(d1.digest).toBe(d2.digest);
    });

    it('normalizes negative zero to zero', () => {
      expect(normalizeNumericValue(-0)).toBe(0);
      expect(stableStringify({ val: -0 })).toBe('{"val":0}');
    });

    it('rejects non-finite numbers (NaN and Infinity)', () => {
      expect(() => normalizeNumericValue(NaN)).toThrow(/non-finite number/);
      expect(() => normalizeNumericValue(Infinity)).toThrow(/non-finite number/);
      expect(() => stableStringify({ val: NaN })).toThrow(/non-finite number/);
    });

    it('preserves leading zeros in string identifiers', () => {
      expect(normalizeNumericValue('007')).toBe('007');
      expect(normalizeNumericValue('0x123')).toBe('0x123');
    });
  });

  describe('4. Null, undefined, defaults, and excluded volatile fields', () => {
    it('automatically excludes volatile fields across rebuild and live environments', async () => {
      const rebuildRows = [
        {
          id: 'claim-1',
          claimant: '0x1234',
          amount: '500',
          createdAt: new Date('2026-10-17T10:00:00Z'),
          updatedAt: new Date('2026-10-17T10:05:00Z'),
          syncedAt: '2026-10-17T10:10:00Z',
          internalId: 1001,
          __v: 0,
        },
      ];

      const liveRows = [
        {
          id: 'claim-1',
          claimant: '0x1234',
          amount: '500',
          createdAt: new Date('2026-09-01T08:00:00Z'), // Different creation timestamp in live
          updatedAt: new Date('2026-09-02T09:00:00Z'), // Different update timestamp in live
          syncedAt: '2026-10-17T12:00:00Z', // Different sync timestamp
          internalId: 99999, // Different surrogate DB id
          __v: 2,
        },
      ];

      const rebuildDigest = await digestProjector('claims', rebuildRows, {
        ...baseContext,
        schema: 'replay_shadow',
      });
      const liveDigest = await digestProjector('claims', liveRows, {
        ...baseContext,
        schema: 'public',
      });

      // Canonical data digests match because volatile fields are excluded
      expect(rebuildDigest.digest).toBe(liveDigest.digest);
    });

    it('omits undefined properties identically', () => {
      const a = { x: 1, y: undefined };
      const b = { x: 1 };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it('handles null stripping when configured', async () => {
      const rowsA = [{ id: '1', extra: null, status: 'OPEN' }];
      const rowsB = [{ id: '1', status: 'OPEN' }];

      const dA = await digestProjector('claims', rowsA, {
        ...baseContext,
        stripNulls: true,
      });
      const dB = await digestProjector('claims', rowsB, {
        ...baseContext,
        stripNulls: true,
      });

      expect(dA.digest).toBe(dB.digest);
    });

    it('substitutes default values for missing or null properties', async () => {
      const rowsA = [{ id: '1', status: 'ACTIVE', flags: 0 }];
      const rowsB = [{ id: '1', status: null }]; // flags omitted, status null

      const defaults = { status: 'ACTIVE', flags: 0 };

      const dA = await digestProjector('claims', rowsA, {
        ...baseContext,
        defaults,
      });
      const dB = await digestProjector('claims', rowsB, {
        ...baseContext,
        defaults,
      });

      expect(dA.digest).toBe(dB.digest);
    });
  });

  describe('5. Large dataset handling', () => {
    it('deterministically digests 5,000+ rows with bounded memory and ordering', async () => {
      const count = 5000;
      const originalRows: Record<string, unknown>[] = [];
      for (let i = 0; i < count; i++) {
        originalRows.push({
          idx: i,
          uid: `id-${(i * 37) % count}`,
          balance: `${(i * 1.5).toFixed(2)}`,
          status: i % 2 === 0 ? 'ACTIVE' : 'PENDING',
        });
      }

      // Reverse order array
      const shuffledRows = [...originalRows].reverse();

      const startTime = Date.now();
      const digest1 = await digestProjector('large_table', originalRows, baseContext);
      const digest2 = await digestProjector('large_table', shuffledRows, baseContext);
      const durationMs = Date.now() - startTime;

      expect(digest1.rowCount).toBe(count);
      expect(digest2.rowCount).toBe(count);
      expect(digest1.digest).toBe(digest2.digest);
      expect(durationMs).toBeLessThan(5000); // Efficient execution
    });
  });

  describe('6. Tamper tests', () => {
    it('modifying any single canonical property changes the digest', async () => {
      const row = { claimId: 'c1', amount: '1000', verifier: '0xAlice', flag: true };
      const original = await digestProjector('test', [row], baseContext);

      // Mutate string by 1 character
      const mutatedString = await digestProjector(
        'test',
        [{ ...row, amount: '1001' }],
        baseContext,
      );
      expect(mutatedString.digest).not.toBe(original.digest);

      // Mutate address by 1 char
      const mutatedAddress = await digestProjector(
        'test',
        [{ ...row, verifier: '0xBob' }],
        baseContext,
      );
      expect(mutatedAddress.digest).not.toBe(original.digest);

      // Flip boolean
      const mutatedBool = await digestProjector(
        'test',
        [{ ...row, flag: false }],
        baseContext,
      );
      expect(mutatedBool.digest).not.toBe(original.digest);

      // Add a row
      const addedRow = await digestProjector(
        'test',
        [row, { claimId: 'c2', amount: '500', verifier: '0xBob', flag: true }],
        baseContext,
      );
      expect(addedRow.digest).not.toBe(original.digest);
      expect(addedRow.rowCount).toBe(2);

      // Delete a row
      const empty = await digestProjector('test', [], baseContext);
      expect(empty.digest).not.toBe(original.digest);
      expect(empty.rowCount).toBe(0);
    });
  });

  describe('7. Digest identity and envelope binding', () => {
    it('includes projection, schema, release, chainId, and artifactChecksum in metadata', async () => {
      const rows = [{ id: '1', val: 'test' }];
      const digest = await digestProjector('projector-alpha', rows, {
        schema: 'replay_shadow',
        releaseId: 'v2.1.0',
        chainId: 10,
        deploymentBlock: 50000,
        artifactChecksum: '0xabc123',
      });

      expect(digest.projector).toBe('projector-alpha');
      expect(digest.schema).toBe('replay_shadow');
      expect(digest.releaseId).toBe('v2.1.0');
      expect(digest.chainId).toBe(10);
      expect(digest.deploymentBlock).toBe(50000);
      expect(digest.artifactChecksum).toBe('0xabc123');
      expect(digest.rowCount).toBe(1);
      expect(digest.envelopeDigest).toBeDefined();
      expect(digest.envelopeDigest).toHaveLength(64);

      expect(digest.metadata).toEqual(
        expect.objectContaining({
          projector: 'projector-alpha',
          schema: 'replay_shadow',
          releaseId: 'v2.1.0',
          chainId: 10,
          deploymentBlock: 50000,
          artifactChecksum: '0xabc123',
          algorithm: 'sha256',
          canonicalVersion: 'v1',
          rowCount: 1,
          dataDigest: digest.digest,
        }),
      );
    });

    it('cross-environment data equivalence holds while envelope reflects schema difference', async () => {
      const rows = [{ id: 'item-1', balance: '500' }];

      const rebuild = await digestProjector('balances', rows, {
        ...baseContext,
        schema: 'replay_shadow',
      });

      const live = await digestProjector('balances', rows, {
        ...baseContext,
        schema: 'public',
      });

      // Data digests match across schemas
      expect(rebuild.digest).toBe(live.digest);

      // Envelope digests differ because schema identity is bound into the envelope
      expect(rebuild.envelopeDigest).not.toBe(live.envelopeDigest);
      expect(rebuild.schema).toBe('replay_shadow');
      expect(live.schema).toBe('public');
    });
  });

  describe('8. Typed actionable errors on missing digests and drift', () => {
    it('throws MissingProjectionDigestError when a projector is missing in rebuild', () => {
      const rebuildDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111',
          schema: 'replay_shadow',
        },
      ];
      const liveDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111',
          schema: 'public',
        },
        {
          projector: 'rewards',
          rowCount: 5,
          digest: 'bbb222',
          schema: 'public',
        },
      ];

      expect(() =>
        compareProjectionDigests(rebuildDigests, liveDigests, { failClosed: true }),
      ).toThrow(MissingProjectionDigestError);

      try {
        compareProjectionDigests(rebuildDigests, liveDigests, { failClosed: true });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MissingProjectionDigestError);
        const typed = err as MissingProjectionDigestError;
        expect(typed.code).toBe('MISSING_PROJECTION_DIGEST');
        expect(typed.projector).toBe('rewards');
        expect(typed.actionableAdvice).toContain('rewards');
        expect(typed.actionableAdvice).toContain('rebuilt');
      }
    });

    it('throws ProjectionDigestMismatchError on canonical field drift', () => {
      const rebuildDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111_rebuild',
          schema: 'replay_shadow',
        },
      ];
      const liveDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111_live',
          schema: 'public',
        },
      ];

      expect(() =>
        compareProjectionDigests(rebuildDigests, liveDigests, { failClosed: true }),
      ).toThrow(ProjectionDigestMismatchError);

      try {
        compareProjectionDigests(rebuildDigests, liveDigests, { failClosed: true });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ProjectionDigestMismatchError);
        const typed = err as ProjectionDigestMismatchError;
        expect(typed.code).toBe('PROJECTION_DIGEST_MISMATCH');
        expect(typed.projector).toBe('claims');
        expect(typed.actionableAdvice).toContain('drift');
      }
    });

    it('throws ProjectionBindingMismatchError when chainId or releaseId drifts', () => {
      const rebuildDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111',
          chainId: 10,
          releaseId: 'v2.1.0',
        },
      ];
      const liveDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111',
          chainId: 11155420, // Chain mismatch!
          releaseId: 'v2.1.0',
        },
      ];

      expect(() =>
        compareProjectionDigests(rebuildDigests, liveDigests, {
          failClosed: true,
          verifyBinding: true,
        }),
      ).toThrow(ProjectionBindingMismatchError);
    });

    it('returns structured report with all diffs when failClosed is false', () => {
      const rebuildDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111',
          schema: 'replay_shadow',
        },
        {
          projector: 'disputes',
          rowCount: 3,
          digest: 'drifted_hash',
          schema: 'replay_shadow',
        },
      ];
      const liveDigests: ProjectionDigest[] = [
        {
          projector: 'claims',
          rowCount: 10,
          digest: 'aaa111',
          schema: 'public',
        },
        {
          projector: 'disputes',
          rowCount: 3,
          digest: 'expected_hash',
          schema: 'public',
        },
        {
          projector: 'rewards',
          rowCount: 8,
          digest: 'ccc333',
          schema: 'public',
        },
      ];

      const report = compareProjectionDigests(rebuildDigests, liveDigests, {
        failClosed: false,
      });

      expect(report.equivalent).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.diffs).toHaveLength(3);

      const claimsDiff = report.diffs.find((d) => d.projector === 'claims');
      const disputesDiff = report.diffs.find((d) => d.projector === 'disputes');
      const rewardsDiff = report.diffs.find((d) => d.projector === 'rewards');

      expect(claimsDiff?.status).toBe('match');
      expect(disputesDiff?.status).toBe('mismatch');
      expect(rewardsDiff?.status).toBe('missing_in_rebuild');
    });
  });
});
