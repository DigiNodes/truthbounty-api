import { computeAuditRecordHash, verifyAuditRecordHash } from './integrity';

describe('integrity', () => {
  const baseRecord = {
    id: 'audit-1',
    actionType: 'CLAIM_CREATED',
    entityType: 'CLAIM',
    entityId: 'claim-1',
    userId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    previousHash: null,
    chainSequence: 1,
  };
  const secret = 'unit-test-secret';

  describe('computeAuditRecordHash', () => {
    it('is deterministic for the same record and secret', () => {
      const first = computeAuditRecordHash(baseRecord, secret);
      const second = computeAuditRecordHash(baseRecord, secret);
      expect(first).toBe(second);
    });

    it('changes when any hashed field changes', () => {
      const original = computeAuditRecordHash(baseRecord, secret);
      const changed = computeAuditRecordHash({ ...baseRecord, entityId: 'claim-2' }, secret);
      expect(changed).not.toBe(original);
    });

    it('changes when previousHash or chainSequence changes', () => {
      const original = computeAuditRecordHash(baseRecord, secret);
      const differentLink = computeAuditRecordHash(
        { ...baseRecord, previousHash: 'some-prior-hash' },
        secret,
      );
      const differentSequence = computeAuditRecordHash(
        { ...baseRecord, chainSequence: 2 },
        secret,
      );
      expect(differentLink).not.toBe(original);
      expect(differentSequence).not.toBe(original);
    });

    it('produces a different hash under a different secret (keyed, not a plain digest)', () => {
      const withSecretA = computeAuditRecordHash(baseRecord, 'secret-a');
      const withSecretB = computeAuditRecordHash(baseRecord, 'secret-b');
      expect(withSecretA).not.toBe(withSecretB);
    });

    it('is not affected by key order within the record object', () => {
      const reordered = {
        chainSequence: baseRecord.chainSequence,
        previousHash: baseRecord.previousHash,
        createdAt: baseRecord.createdAt,
        entityId: baseRecord.entityId,
        entityType: baseRecord.entityType,
        actionType: baseRecord.actionType,
        userId: baseRecord.userId,
        id: baseRecord.id,
      };
      expect(computeAuditRecordHash(reordered as any, secret)).toBe(
        computeAuditRecordHash(baseRecord, secret),
      );
    });
  });

  describe('verifyAuditRecordHash', () => {
    it('returns true for an untampered record', () => {
      const integrityHash = computeAuditRecordHash(baseRecord, secret);
      expect(verifyAuditRecordHash({ ...baseRecord, integrityHash }, secret)).toBe(true);
    });

    it('returns false when the record was edited after hashing', () => {
      const integrityHash = computeAuditRecordHash(baseRecord, secret);
      expect(
        verifyAuditRecordHash(
          { ...baseRecord, entityId: 'claim-tampered', integrityHash },
          secret,
        ),
      ).toBe(false);
    });

    it('returns false without recomputing the secret-less hash correctly if the wrong secret is used', () => {
      const integrityHash = computeAuditRecordHash(baseRecord, 'secret-a');
      expect(verifyAuditRecordHash({ ...baseRecord, integrityHash }, 'secret-b')).toBe(false);
    });

    it('returns false when integrityHash is missing', () => {
      expect(verifyAuditRecordHash({ ...baseRecord, integrityHash: null }, secret)).toBe(false);
      expect(verifyAuditRecordHash({ ...baseRecord } as any, secret)).toBe(false);
    });
  });
});
