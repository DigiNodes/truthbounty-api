import {
  REBUILD_DIGEST_SEED,
  RebuildCheckpoint,
  canonicalEventIdentity,
  emptyCounter,
  foldDigest,
  initialDigest,
  serializeCheckpoint,
} from './rebuild-checkpoint';

const EVENTS = [
  { chainId: 10, txHash: '0xaa', logIndex: 0, eventName: 'EvidenceRegistered' },
  { chainId: 10, txHash: '0xaa', logIndex: 1, eventName: 'PositionCommitted' },
  { chainId: 10, txHash: '0xbb', logIndex: 0, eventName: 'RewardAllocated' },
];

function identities(
  events: ReadonlyArray<{
    chainId: number;
    txHash: string;
    logIndex: number;
    eventName: string;
  }>,
): string[] {
  return events.map(canonicalEventIdentity);
}

describe('rebuild checkpoint determinism', () => {
  describe('canonicalEventIdentity', () => {
    it('includes chain, transaction, log index, and event name', () => {
      expect(canonicalEventIdentity(EVENTS[0])).toBe(
        '10:0xaa:0:EvidenceRegistered',
      );
    });

    it('distinguishes two logs in the same transaction', () => {
      expect(canonicalEventIdentity(EVENTS[0])).not.toBe(
        canonicalEventIdentity(EVENTS[1]),
      );
    });
  });

  describe('foldDigest', () => {
    it('is a pure function of the seed and the identity sequence', () => {
      const a = foldDigest(initialDigest(), identities(EVENTS));
      const b = foldDigest(initialDigest(), identities(EVENTS));
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('is stable across batch boundaries — one batch equals three', () => {
      const one = foldDigest(initialDigest(), identities(EVENTS));
      const three = foldDigest(
        foldDigest(
          foldDigest(initialDigest(), identities(EVENTS.slice(0, 1))),
          identities(EVENTS.slice(1, 2)),
        ),
        identities(EVENTS.slice(2, 3)),
      );
      expect(three).toBe(one);
    });

    it('is order-dependent, so a reordered log is detectable', () => {
      const inOrder = foldDigest(initialDigest(), identities(EVENTS));
      const reordered = foldDigest(
        initialDigest(),
        identities([EVENTS[1], EVENTS[0], EVENTS[2]]),
      );
      expect(reordered).not.toBe(inOrder);
    });

    it('changes when an event is added', () => {
      const base = foldDigest(initialDigest(), identities(EVENTS));
      const extended = foldDigest(
        initialDigest(),
        identities([
          ...EVENTS,
          { chainId: 10, txHash: '0xcc', logIndex: 0, eventName: 'DisputeRaised' },
        ]),
      );
      expect(extended).not.toBe(base);
    });

    it('leaves the accumulator unchanged for an empty batch', () => {
      const before = foldDigest(initialDigest(), identities(EVENTS));
      expect(foldDigest(before, [])).toBe(before);
    });

    it('starts from a fixed, published seed', () => {
      expect(REBUILD_DIGEST_SEED).toBe('truthbounty:v2:projection-rebuild:v1');
      expect(initialDigest()).toHaveLength(64);
      expect(initialDigest()).not.toBe(REBUILD_DIGEST_SEED);
    });
  });

  describe('serializeCheckpoint', () => {
    const base = (): RebuildCheckpoint => ({
      chainId: 10,
      deploymentBlock: '1000',
      fromBlock: '1001',
      toBlock: '1099',
      logIndex: 3,
      batchesProcessed: 2,
      eventsConsumed: 3,
      eventsApplied: 3,
      eventsSkipped: 0,
      anomalies: 0,
      unclaimedEvents: 0,
      inputDigest: 'a'.repeat(64),
      perProjection: {
        'v2-rewards': emptyCounter(),
        'v2-evidence': emptyCounter(),
      },
      safeToCutover: true,
      complete: true,
    });

    it('serialises identically regardless of key insertion order', () => {
      const a = base();
      const b: RebuildCheckpoint = {
        ...base(),
        perProjection: {
          'v2-evidence': emptyCounter(),
          'v2-rewards': emptyCounter(),
        },
      };
      expect(serializeCheckpoint(b)).toBe(serializeCheckpoint(a));
    });

    it('contains no timestamp, so two runs of the same data are byte-identical', () => {
      const rendered = serializeCheckpoint(base());
      expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(rendered).not.toContain('runId');
      expect(rendered).not.toContain('durationMs');
    });

    it('emits keys in sorted order at every level', () => {
      const rendered = serializeCheckpoint(base());
      const topLevel = Object.keys(JSON.parse(rendered) as object);
      expect(topLevel).toEqual([...topLevel].sort());
      const projections = Object.keys(
        (JSON.parse(rendered) as { perProjection: object }).perProjection,
      );
      expect(projections).toEqual([...projections].sort());
    });
  });
});
