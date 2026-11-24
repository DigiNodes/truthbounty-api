import { BadRequestException } from '@nestjs/common';
import {
  CLAIM_LIST_CURSOR_VERSION,
  decodeClaimListCursor,
  encodeClaimListCursor,
} from './claim-read-model.cursor';
import { CLAIM_READ_MODEL_ORDER } from './claim-read-model.types';

describe('claim list cursor', () => {
  const cursor = {
    v: CLAIM_LIST_CURSOR_VERSION,
    claimId: 'claim-0042',
    snapshotAt: '2026-10-16T00:00:00.000Z',
    order: CLAIM_READ_MODEL_ORDER,
    chainId: 11155420,
    state: null,
  };

  it('round-trips a cursor without loss', () => {
    const decoded = decodeClaimListCursor(encodeClaimListCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it('encodes as URL-safe base64', () => {
    const encoded = encodeClaimListCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('preserves a state filter fingerprint', () => {
    const decoded = decodeClaimListCursor(
      encodeClaimListCursor({ ...cursor, state: 'SETTLED' }),
    );
    expect(decoded.state).toBe('SETTLED');
  });

  it('rejects non-JSON payloads', () => {
    expect(() => decodeClaimListCursor('not-a-cursor')).toThrow(
      BadRequestException,
    );
  });

  it('rejects a payload with an unsupported version', () => {
    const payload = Buffer.from(
      JSON.stringify({ ...cursor, v: 999 }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeClaimListCursor(payload)).toThrow(BadRequestException);
  });

  it('rejects a tampered ordering', () => {
    const payload = Buffer.from(
      JSON.stringify({ ...cursor, order: 'updatedAt:desc' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeClaimListCursor(payload)).toThrow(BadRequestException);
  });

  it('rejects a cursor missing required fields', () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, order: CLAIM_READ_MODEL_ORDER }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeClaimListCursor(payload)).toThrow(BadRequestException);
  });
});
