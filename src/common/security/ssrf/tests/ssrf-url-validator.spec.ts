import {
  validateTargetUrl,
  resolveAndValidateDns,
  SsrfSecurityException,
} from '../ssrf-url-validator';

describe('ssrf-url-validator', () => {
  describe('validateTargetUrl', () => {
    describe('Protocol Validation', () => {
      it('should allow valid http and https URLs', () => {
        expect(() => validateTargetUrl('https://example.com')).not.toThrow();
        expect(() => validateTargetUrl('http://example.com/api')).not.toThrow();
      });

      it('should reject non-http(s) protocols (file, ftp, gopher, data, javascript)', () => {
        expect(() => validateTargetUrl('file:///etc/passwd')).toThrow(
          SsrfSecurityException,
        );
        expect(() => validateTargetUrl('ftp://example.com/file')).toThrow(
          SsrfSecurityException,
        );
        expect(() => validateTargetUrl('gopher://example.com:70/')).toThrow(
          SsrfSecurityException,
        );
        expect(() =>
          validateTargetUrl('data:text/plain;base64,SGVsbG8='),
        ).toThrow(SsrfSecurityException);
        expect(() => validateTargetUrl('javascript:alert(1)')).toThrow(
          SsrfSecurityException,
        );
      });
    });

    describe('Credential-Bearing Targets (Userinfo)', () => {
      it('should block URLs with username and password', () => {
        expect(() =>
          validateTargetUrl('http://admin:secret@example.com/api'),
        ).toThrow('Credential-bearing targets');
      });

      it('should block URLs with username only', () => {
        expect(() => validateTargetUrl('http://user@example.com/api')).toThrow(
          'Credential-bearing targets',
        );
      });
    });

    describe('Port Validation', () => {
      it('should allow standard ports 80 and 443 by default', () => {
        expect(() => validateTargetUrl('http://example.com:80')).not.toThrow();
        expect(() =>
          validateTargetUrl('https://example.com:443'),
        ).not.toThrow();
      });

      it('should reject non-standard internal ports by default (22, 25, 3306, 6379, 8080)', () => {
        expect(() => validateTargetUrl('http://example.com:22')).toThrow(
          'is forbidden',
        );
        expect(() => validateTargetUrl('http://example.com:6379')).toThrow(
          'is forbidden',
        );
        expect(() => validateTargetUrl('http://example.com:8080')).toThrow(
          'is forbidden',
        );
      });

      it('should respect custom allowedPorts', () => {
        expect(() =>
          validateTargetUrl('http://example.com:8080', {
            allowedPorts: [80, 443, 8080],
          }),
        ).not.toThrow();
      });
    });

    describe('Direct and Encoded IP in URLs', () => {
      it('should block direct loopback URLs (127.0.0.1, [::1])', () => {
        expect(() => validateTargetUrl('http://127.0.0.1')).toThrow(
          SsrfSecurityException,
        );
        expect(() => validateTargetUrl('http://[::1]')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should block dword-encoded loopback (http://2130706433/)', () => {
        expect(() => validateTargetUrl('http://2130706433')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should block hex-encoded loopback (http://0x7f000001/)', () => {
        expect(() => validateTargetUrl('http://0x7f000001')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should block octal-encoded loopback (http://0177.0.0.1/)', () => {
        expect(() => validateTargetUrl('http://0177.0.0.1')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should block cloud metadata IP (http://169.254.169.254/)', () => {
        expect(() =>
          validateTargetUrl('http://169.254.169.254/latest/meta-data'),
        ).toThrow(SsrfSecurityException);
      });

      it('should block private IPv4 (http://10.0.0.1/, http://192.168.1.1/)', () => {
        expect(() => validateTargetUrl('http://10.0.0.1')).toThrow(
          SsrfSecurityException,
        );
        expect(() => validateTargetUrl('http://192.168.1.1')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should block IPv6 ULA and link-local (http://[fc00::1]/, http://[fe80::1]/)', () => {
        expect(() => validateTargetUrl('http://[fc00::1]')).toThrow(
          SsrfSecurityException,
        );
        expect(() => validateTargetUrl('http://[fe80::1]')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should allow valid public IP targets', () => {
        expect(() => validateTargetUrl('https://8.8.8.8')).not.toThrow();
        expect(() => validateTargetUrl('https://1.1.1.1')).not.toThrow();
      });
    });

    describe('Forbidden Hostnames', () => {
      it('should block localhost and localhost.localdomain', () => {
        expect(() => validateTargetUrl('http://localhost')).toThrow(
          SsrfSecurityException,
        );
        expect(() => validateTargetUrl('http://localhost.localdomain')).toThrow(
          SsrfSecurityException,
        );
      });

      it('should block cloud metadata hostnames', () => {
        expect(() =>
          validateTargetUrl('http://metadata.google.internal'),
        ).toThrow(SsrfSecurityException);
        expect(() => validateTargetUrl('http://metadata.internal')).toThrow(
          SsrfSecurityException,
        );
      });
    });
  });

  describe('resolveAndValidateDns', () => {
    it('should block domain that resolves to loopback IP', async () => {
      const mockResolver = jest
        .fn()
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      await expect(
        resolveAndValidateDns('evil.com', { dnsResolver: mockResolver }),
      ).rejects.toThrow('forbidden address');
    });

    it('should block domain that resolves to private network IP', async () => {
      const mockResolver = jest
        .fn()
        .mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);

      await expect(
        resolveAndValidateDns('internal.corp', { dnsResolver: mockResolver }),
      ).rejects.toThrow('forbidden address');
    });

    it('should block domain that resolves to cloud metadata IP', async () => {
      const mockResolver = jest
        .fn()
        .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

      await expect(
        resolveAndValidateDns('metadata.attacker.com', {
          dnsResolver: mockResolver,
        }),
      ).rejects.toThrow('cloud metadata service');
    });

    it('should block domain if ANY of multiple resolved records is forbidden', async () => {
      const mockResolver = jest.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 }, // public
        { address: '10.0.0.1', family: 4 }, // private
      ]);

      await expect(
        resolveAndValidateDns('dual-homed.com', { dnsResolver: mockResolver }),
      ).rejects.toThrow('forbidden address');
    });

    it('should allow domain resolving to all public IPs', async () => {
      const mockResolver = jest.fn().mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);

      const records = await resolveAndValidateDns('example.com', {
        dnsResolver: mockResolver,
      });

      expect(records).toHaveLength(2);
      expect(records[0].address).toBe('93.184.216.34');
    });

    it('should throw if DNS returns no records', async () => {
      const mockResolver = jest.fn().mockResolvedValue([]);

      await expect(
        resolveAndValidateDns('empty.com', { dnsResolver: mockResolver }),
      ).rejects.toThrow('No DNS records resolved');
    });
  });
});
