import {
  parseAndNormalizeIpv4,
  validateIpAddress,
  ipv6ToBigInt,
  intToIpv4,
} from '../ip-parser.util';

describe('ip-parser.util', () => {
  describe('intToIpv4', () => {
    it('should convert 32-bit int to dotted IPv4', () => {
      expect(intToIpv4(2130706433)).toBe('127.0.0.1');
      expect(intToIpv4(0)).toBe('0.0.0.0');
      expect(intToIpv4(0xffffffff)).toBe('255.255.255.255');
    });
  });

  describe('parseAndNormalizeIpv4 (encoded IPs)', () => {
    it('should parse standard dotted-decimal IPv4', () => {
      expect(parseAndNormalizeIpv4('127.0.0.1')).toBe('127.0.0.1');
      expect(parseAndNormalizeIpv4('192.168.1.50')).toBe('192.168.1.50');
      expect(parseAndNormalizeIpv4('8.8.8.8')).toBe('8.8.8.8');
    });

    it('should parse single decimal integer (dword)', () => {
      // 127.0.0.1 = 2130706433
      expect(parseAndNormalizeIpv4('2130706433')).toBe('127.0.0.1');
      // 169.254.169.254 = 2852039166
      expect(parseAndNormalizeIpv4('2852039166')).toBe('169.254.169.254');
    });

    it('should parse single hex integer', () => {
      expect(parseAndNormalizeIpv4('0x7f000001')).toBe('127.0.0.1');
      expect(parseAndNormalizeIpv4('0xA9FEA9FE')).toBe('169.254.169.254');
    });

    it('should parse single octal integer', () => {
      expect(parseAndNormalizeIpv4('017700000001')).toBe('127.0.0.1');
    });

    it('should parse dotted hex notation', () => {
      expect(parseAndNormalizeIpv4('0x7f.0.0.1')).toBe('127.0.0.1');
      expect(parseAndNormalizeIpv4('0x7f.0x0.0x0.0x1')).toBe('127.0.0.1');
    });

    it('should parse dotted octal notation', () => {
      expect(parseAndNormalizeIpv4('0177.0.0.1')).toBe('127.0.0.1');
      expect(parseAndNormalizeIpv4('0177.0000.0000.0001')).toBe('127.0.0.1');
    });

    it('should parse partial/classful IP formats (doublet/triplet)', () => {
      expect(parseAndNormalizeIpv4('127.1')).toBe('127.0.0.1');
      expect(parseAndNormalizeIpv4('127.0.1')).toBe('127.0.0.1');
    });

    it('should return null for non-IP strings', () => {
      expect(parseAndNormalizeIpv4('example.com')).toBeNull();
      expect(parseAndNormalizeIpv4('localhost')).toBeNull();
      expect(parseAndNormalizeIpv4('999.999.999.999')).toBeNull();
      expect(parseAndNormalizeIpv4('')).toBeNull();
    });
  });

  describe('IPv6 parsing', () => {
    it('should parse loopback ::1', () => {
      const parsed = ipv6ToBigInt('::1');
      expect(parsed).not.toBeNull();
      expect(parsed?.bigInt).toBe(1n);
    });

    it('should parse full IPv6 address', () => {
      const parsed = ipv6ToBigInt('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
      expect(parsed).not.toBeNull();
    });

    it('should parse bracketed IPv6', () => {
      const parsed = ipv6ToBigInt('[::1]');
      expect(parsed).not.toBeNull();
      expect(parsed?.bigInt).toBe(1n);
    });

    it('should parse IPv4-mapped IPv6', () => {
      const parsed = ipv6ToBigInt('::ffff:127.0.0.1');
      expect(parsed).not.toBeNull();
      expect(parsed?.mappedIpv4).toBe('127.0.0.1');
    });
  });

  describe('validateIpAddress (Private ranges & metadata)', () => {
    describe('IPv4 Private and Reserved Ranges', () => {
      it('should block loopback 127.0.0.0/8', () => {
        expect(validateIpAddress('127.0.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('127.255.255.254').isForbidden).toBe(true);
      });

      it('should block RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)', () => {
        expect(validateIpAddress('10.0.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('10.254.1.1').isForbidden).toBe(true);
        expect(validateIpAddress('172.16.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('172.31.255.254').isForbidden).toBe(true);
        expect(validateIpAddress('192.168.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('192.168.1.100').isForbidden).toBe(true);
      });

      it('should block link-local 169.254.0.0/16', () => {
        expect(validateIpAddress('169.254.1.1').isForbidden).toBe(true);
        expect(validateIpAddress('169.254.169.254').isForbidden).toBe(true);
      });

      it('should block 0.0.0.0/8', () => {
        expect(validateIpAddress('0.0.0.0').isForbidden).toBe(true);
        expect(validateIpAddress('0.1.2.3').isForbidden).toBe(true);
      });

      it('should block carrier-grade NAT 100.64.0.0/10', () => {
        expect(validateIpAddress('100.64.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('100.127.255.254').isForbidden).toBe(true);
      });

      it('should block multicast 224.0.0.0/4 and reserved 240.0.0.0/4', () => {
        expect(validateIpAddress('224.0.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('240.0.0.1').isForbidden).toBe(true);
        expect(validateIpAddress('255.255.255.255').isForbidden).toBe(true);
      });

      it('should block test-net documentation IPs (RFC 5737)', () => {
        expect(validateIpAddress('192.0.2.1').isForbidden).toBe(true);
        expect(validateIpAddress('198.51.100.1').isForbidden).toBe(true);
        expect(validateIpAddress('203.0.113.1').isForbidden).toBe(true);
      });
    });

    describe('Cloud Metadata IPs', () => {
      it('should block AWS / Azure / GCP metadata 169.254.169.254', () => {
        const res = validateIpAddress('169.254.169.254');
        expect(res.isForbidden).toBe(true);
      });

      it('should block Oracle Cloud metadata 169.254.0.1', () => {
        expect(validateIpAddress('169.254.0.1').isForbidden).toBe(true);
      });

      it('should block Alibaba Cloud metadata 100.100.100.200', () => {
        expect(validateIpAddress('100.100.100.200').isForbidden).toBe(true);
      });
    });

    describe('Encoded IPs', () => {
      it('should block hex-encoded loopback 0x7f000001', () => {
        const res = validateIpAddress('0x7f000001');
        expect(res.isForbidden).toBe(true);
        expect(res.normalizedIp).toBe('127.0.0.1');
      });

      it('should block dword-encoded loopback 2130706433', () => {
        const res = validateIpAddress('2130706433');
        expect(res.isForbidden).toBe(true);
        expect(res.normalizedIp).toBe('127.0.0.1');
      });

      it('should block octal-encoded loopback 0177.0.0.1', () => {
        const res = validateIpAddress('0177.0.0.1');
        expect(res.isForbidden).toBe(true);
        expect(res.normalizedIp).toBe('127.0.0.1');
      });

      it('should block hex-encoded metadata 0xA9FEA9FE', () => {
        const res = validateIpAddress('0xA9FEA9FE');
        expect(res.isForbidden).toBe(true);
        expect(res.normalizedIp).toBe('169.254.169.254');
      });
    });

    describe('IPv6 Private and Special Ranges', () => {
      it('should block IPv6 loopback ::1', () => {
        expect(validateIpAddress('::1').isForbidden).toBe(true);
      });

      it('should block IPv6 unspecified ::', () => {
        expect(validateIpAddress('::').isForbidden).toBe(true);
      });

      it('should block IPv6 Unique Local Address (ULA) fc00::/7', () => {
        expect(validateIpAddress('fc00::1').isForbidden).toBe(true);
        expect(validateIpAddress('fd12:3456:789a::1').isForbidden).toBe(true);
      });

      it('should block IPv6 link-local fe80::/10', () => {
        expect(validateIpAddress('fe80::1').isForbidden).toBe(true);
        expect(validateIpAddress('febf::ffff').isForbidden).toBe(true);
      });

      it('should block IPv6 multicast ff00::/8', () => {
        expect(validateIpAddress('ff02::1').isForbidden).toBe(true);
      });

      it('should block IPv4-mapped loopback ::ffff:127.0.0.1', () => {
        const res = validateIpAddress('::ffff:127.0.0.1');
        expect(res.isForbidden).toBe(true);
      });

      it('should block IPv4-mapped private ::ffff:10.0.0.1', () => {
        const res = validateIpAddress('::ffff:10.0.0.1');
        expect(res.isForbidden).toBe(true);
      });

      it('should block IPv4-mapped metadata ::ffff:169.254.169.254', () => {
        const res = validateIpAddress('::ffff:169.254.169.254');
        expect(res.isForbidden).toBe(true);
      });
    });

    describe('Allowed Public IPs', () => {
      it('should allow valid public IPv4 addresses', () => {
        expect(validateIpAddress('8.8.8.8').isForbidden).toBe(false);
        expect(validateIpAddress('1.1.1.1').isForbidden).toBe(false);
        expect(validateIpAddress('93.184.216.34').isForbidden).toBe(false);
        expect(validateIpAddress('142.250.190.46').isForbidden).toBe(false);
      });

      it('should allow valid public IPv6 addresses', () => {
        expect(validateIpAddress('2606:4700:4700::1111').isForbidden).toBe(
          false,
        );
        expect(validateIpAddress('2001:4860:4860::8888').isForbidden).toBe(
          false,
        );
      });
    });
  });
});
