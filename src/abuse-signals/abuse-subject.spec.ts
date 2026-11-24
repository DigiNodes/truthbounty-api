import {
  ATTACKER_CONTROLLED_IDENTITY_HEADERS,
  identityInputFromRequest,
  normalizeAddress,
  resolveAbuseSubject,
  resolveTrustedAddress,
} from './abuse-subject';
import {
  AbuseAttributionFailure,
  AbuseSubjectKind,
} from './abuse-signals.types';
import { TEST_SALT } from './abuse-signals.harness';

function attributed(input: Parameters<typeof resolveAbuseSubject>[0]) {
  const resolution = resolveAbuseSubject(input);
  if (!resolution.attributed) {
    throw new Error(`expected attribution, got ${resolution.reason}`);
  }
  return resolution.subject;
}

describe('abuse subject resolution (PREWAVE-BE-086)', () => {
  describe('trusted sources only', () => {
    it('prefers a verified principal over anything else on the request', () => {
      const subject = attributed({
        principalId: 'user-123',
        walletAddress: '0x' + 'a'.repeat(40),
        socketRemoteAddress: '198.51.100.7',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(subject.kind).toBe(AbuseSubjectKind.PRINCIPAL);
    });

    it('accepts a wallet only from a validated claim', () => {
      const subject = attributed({
        walletAddress: '0x' + 'A'.repeat(40),
        socketRemoteAddress: '198.51.100.7',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(subject.kind).toBe(AbuseSubjectKind.WALLET);
    });

    it('derives the same wallet subject regardless of address casing', () => {
      const upper = attributed({
        walletAddress: '0x' + 'A'.repeat(40),
        socketRemoteAddress: null,
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const lower = attributed({
        walletAddress: '0x' + 'a'.repeat(40),
        socketRemoteAddress: null,
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(upper.key).toBe(lower.key);
    });

    it('never returns a raw identifier as the subject key', () => {
      const subject = attributed({
        principalId: 'user-123',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(subject.key).toMatch(/^[0-9a-f]{64}$/);
      expect(subject.key).not.toContain('user-123');
    });

    it('produces different keys under different salts', () => {
      const a = attributed({
        principalId: 'user-123',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const b = attributed({
        principalId: 'user-123',
        trustedProxyHops: 0,
        subjectSalt: `${TEST_SALT}-rotated`,
      });
      expect(a.key).not.toBe(b.key);
    });
  });

  describe('attacker-controlled identifiers are refused', () => {
    it.each(ATTACKER_CONTROLLED_IDENTITY_HEADERS)(
      'ignores the %s header entirely',
      (header) => {
        const subject = attributed(
          identityInputFromRequest(
            {
              socket: { remoteAddress: '198.51.100.7' },
              headers: { [header]: '0x' + 'b'.repeat(40) },
            },
            { trustedProxyHops: 0, subjectSalt: TEST_SALT },
          ),
        );
        expect(subject.kind).toBe(AbuseSubjectKind.NETWORK_PREFIX);
      },
    );

    it('cannot move a forged identifier onto a victim subject', () => {
      const victim = attributed({
        principalId: 'victim',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const attacker = attributed(
        identityInputFromRequest(
          {
            socket: { remoteAddress: '198.51.100.7' },
            headers: {
              'x-wallet-address': '0x' + 'c'.repeat(40),
              'x-wallet': '0x' + 'c'.repeat(40),
            },
          },
          { trustedProxyHops: 0, subjectSalt: TEST_SALT },
        ),
      );
      expect(attacker.key).not.toBe(victim.key);
    });

    it('reports when only an untrusted identifier was offered', () => {
      const resolution = resolveAbuseSubject(
        identityInputFromRequest(
          { headers: { 'x-wallet-address': '0x' + 'b'.repeat(40) } },
          { trustedProxyHops: 0, subjectSalt: TEST_SALT },
        ),
      );
      // Nothing verifiable was present, so the result is unattributed rather
      // than "trust the header".
      expect(resolution).toEqual({
        attributed: false,
        reason: AbuseAttributionFailure.UNIDENTIFIED,
      });
    });

    it('takes the right-most forwarded entries, discarding client-supplied ones', () => {
      // A client prepends forged entries; only the entries our proxies wrote
      // count, so the derived address cannot be chosen by the caller.
      expect(
        resolveTrustedAddress('10.0.0.9', '9.9.9.9, 8.8.8.8, 7.7.7.7', 2),
      ).toBe('8.8.8.8');
      // Fewer forwarded entries than trusted hops: fall back to the socket.
      expect(resolveTrustedAddress('10.0.0.9', '9.9.9.9', 3)).toBe('10.0.0.9');
      // No proxy trust configured: forwarded headers are ignored wholesale.
      expect(resolveTrustedAddress('10.0.0.9', '9.9.9.9', 0)).toBe('10.0.0.9');
    });

    it('handles an array-valued forwarded header', () => {
      expect(
        resolveTrustedAddress('10.0.0.9', ['1.1.1.1, 2.2.2.2'], 1),
      ).toBe('2.2.2.2');
    });
  });

  describe('shared NAT', () => {
    it('collapses an IPv4 /24 into one subject', () => {
      const a = attributed({
        socketRemoteAddress: '198.51.100.1',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const b = attributed({
        socketRemoteAddress: '198.51.100.254',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const elsewhere = attributed({
        socketRemoteAddress: '198.51.101.1',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(a.key).toBe(b.key);
      expect(a.key).not.toBe(elsewhere.key);
    });

    it('collapses an IPv6 /64 into one subject', () => {
      const a = attributed({
        socketRemoteAddress: '2001:db8:1:2::1',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const b = attributed({
        socketRemoteAddress: '2001:db8:1:2:ffff:ffff:ffff:ffff',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const elsewhere = attributed({
        socketRemoteAddress: '2001:db8:1:3::1',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(a.key).toBe(b.key);
      expect(a.key).not.toBe(elsewhere.key);
    });

    it('treats an IPv4-mapped IPv6 address as the same egress as its IPv4 form', () => {
      const v4 = attributed({
        socketRemoteAddress: '198.51.100.7',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      const mapped = attributed({
        socketRemoteAddress: '::ffff:198.51.100.7',
        trustedProxyHops: 0,
        subjectSalt: TEST_SALT,
      });
      expect(v4.key).toBe(mapped.key);
    });
  });

  describe('address normalization', () => {
    it.each([
      ['192.168.1.1:44321', '192.168.1.1'],
      ['[2001:db8::1]:443', '2001:db8::1'],
      ['fe80::1%eth0', 'fe80::1'],
      ['  198.51.100.7  ', '198.51.100.7'],
      ['2001:DB8::1', '2001:db8::1'],
    ])('normalizes %s to %s', (input, expected) => {
      expect(normalizeAddress(input)).toBe(expected);
    });

    it.each(['', '   ', 'not-an-address', '999.999.999.999', null, undefined])(
      'refuses to guess at %p',
      (input) => {
        expect(normalizeAddress(input as string | null)).toBeNull();
      },
    );

    it('does not truncate a bare IPv6 address that contains colons', () => {
      expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1');
    });
  });

  describe('fail closed', () => {
    it('refuses attribution with no salt', () => {
      expect(
        resolveAbuseSubject({
          socketRemoteAddress: '198.51.100.7',
          trustedProxyHops: 0,
          subjectSalt: null,
        }),
      ).toEqual({
        attributed: false,
        reason: AbuseAttributionFailure.CONFIGURATION_UNAVAILABLE,
      });
    });

    it('refuses attribution with a short salt', () => {
      expect(
        resolveAbuseSubject({
          socketRemoteAddress: '198.51.100.7',
          trustedProxyHops: 0,
          subjectSalt: 'too-short',
        }),
      ).toEqual({
        attributed: false,
        reason: AbuseAttributionFailure.CONFIGURATION_UNAVAILABLE,
      });
    });

    it.each([
      'not-a-wallet',
      '0x123',
      `0x${'z'.repeat(40)}`,
      `${'a'.repeat(42)}`,
    ])('refuses the malformed wallet claim %p', (walletAddress) => {
      expect(
        resolveAbuseSubject({
          walletAddress,
          socketRemoteAddress: '198.51.100.7',
          trustedProxyHops: 0,
          subjectSalt: TEST_SALT,
        }),
      ).toEqual({
        attributed: false,
        reason: AbuseAttributionFailure.MALFORMED_IDENTIFIER,
      });
    });

    it('refuses attribution when nothing verifiable is present', () => {
      expect(
        resolveAbuseSubject({
          trustedProxyHops: 0,
          subjectSalt: TEST_SALT,
        }),
      ).toEqual({
        attributed: false,
        reason: AbuseAttributionFailure.UNIDENTIFIED,
      });
    });
  });

  describe('request extraction', () => {
    it('reads only the verified claim fields', () => {
      const input = identityInputFromRequest(
        {
          user: { sub: 'user-9', address: '0x' + 'd'.repeat(40) },
          socket: { remoteAddress: '198.51.100.7' },
          headers: { 'x-wallet-address': '0x' + 'e'.repeat(40) },
          get: (name: string) =>
            name === 'x-forwarded-for' ? '1.1.1.1, 2.2.2.2' : undefined,
        },
        { trustedProxyHops: 1, subjectSalt: TEST_SALT },
      );

      expect(input.principalId).toBe('user-9');
      expect(input.walletAddress).toBe('0x' + 'd'.repeat(40));
      expect(input.socketRemoteAddress).toBe('198.51.100.7');
      expect(input.forwardedFor).toBe('1.1.1.1, 2.2.2.2');
    });

    it('ignores non-string identity values rather than coercing them', () => {
      const input = identityInputFromRequest(
        {
          user: { sub: { toString: () => 'sneaky' }, address: 42 },
          socket: { remoteAddress: null },
        },
        { trustedProxyHops: 0, subjectSalt: TEST_SALT },
      );
      expect(input.principalId).toBeNull();
      expect(input.walletAddress).toBeNull();
    });
  });
});