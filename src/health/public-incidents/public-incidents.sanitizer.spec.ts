import {
  sanitizeMarkdown,
  sanitizeUrl,
} from './public-incidents.sanitizer';

describe('Public Incidents Sanitizer (UX-BE-002)', () => {
  describe('sanitizeMarkdown', () => {
    it('returns empty string for null, undefined, or empty input', () => {
      expect(sanitizeMarkdown(null)).toBe('');
      expect(sanitizeMarkdown(undefined)).toBe('');
      expect(sanitizeMarkdown('')).toBe('');
    });

    it('strips HTML script tags and their contents', () => {
      const input = 'Normal text <script>alert("xss")</script> continuation';
      expect(sanitizeMarkdown(input)).toBe('Normal text  continuation');
    });

    it('strips inline HTML tags (iframe, img onerror, div)', () => {
      const input = 'Hello <iframe src="evil.com"></iframe> <img src="x" onerror="steal()"/> world';
      expect(sanitizeMarkdown(input)).toBe('Hello   world');
    });

    it('neutralizes dangerous schemes in Markdown links', () => {
      const input = 'Click [here](javascript:alert(1)) or [download](data:text/html,<script>)';
      const output = sanitizeMarkdown(input);
      expect(output).toBe('Click [here](#) or [download](#)');
      expect(output).not.toContain('javascript:');
      expect(output).not.toContain('data:');
    });

    it('preserves safe Markdown links and formatting', () => {
      const input = 'Read the [report](https://docs.truthbounty.io/postmortem). **Bold** and *italic* code: `SELECT 1`';
      expect(sanitizeMarkdown(input)).toBe(input);
    });

    it('redacts internal hostnames and connection strings', () => {
      const input = 'Connected to postgres://user:pass@db.internal.truthbounty:5432/db on node.cluster.local';
      const output = sanitizeMarkdown(input);
      expect(output).not.toContain('db.internal.truthbounty');
      expect(output).not.toContain('postgres://');
      expect(output).not.toContain('cluster.local');
      expect(output).toContain('[REDACTED]');
    });

    it('redacts tokens and secrets', () => {
      const input = 'Encountered s3cr3t key and Bearer abc123def456xyz';
      const output = sanitizeMarkdown(input);
      expect(output).not.toContain('s3cr3t');
      expect(output).not.toContain('abc123def456xyz');
      expect(output).toContain('[REDACTED]');
    });
  });

  describe('sanitizeUrl', () => {
    it('returns null for null, undefined, or empty URLs', () => {
      expect(sanitizeUrl(null)).toBeNull();
      expect(sanitizeUrl(undefined)).toBeNull();
      expect(sanitizeUrl('')).toBeNull();
    });

    it('allows valid HTTPS URLs', () => {
      expect(sanitizeUrl('https://docs.truthbounty.io/reports/inc-1')).toBe(
        'https://docs.truthbounty.io/reports/inc-1',
      );
      expect(sanitizeUrl('https://github.com/DigiNodes/truthbounty-protocol')).toBe(
        'https://github.com/DigiNodes/truthbounty-protocol',
      );
    });

    it('rejects non-HTTPS protocols (http, ftp, javascript, data, file)', () => {
      expect(sanitizeUrl('http://insecure.com')).toBeNull();
      expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
      expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
    });

    it('rejects private IP addresses and loopback addresses', () => {
      expect(sanitizeUrl('https://127.0.0.1:8080')).toBeNull();
      expect(sanitizeUrl('https://localhost:3000')).toBeNull();
      expect(sanitizeUrl('https://192.168.1.1/admin')).toBeNull();
      expect(sanitizeUrl('https://10.0.0.5/api')).toBeNull();
      expect(sanitizeUrl('https://172.16.0.1/status')).toBeNull();
    });

    it('rejects cloud metadata IP', () => {
      expect(sanitizeUrl('https://169.254.169.254/latest/meta-data')).toBeNull();
    });

    it('rejects internal domain suffixes (.local, .internal, .lan)', () => {
      expect(sanitizeUrl('https://db.internal/query')).toBeNull();
      expect(sanitizeUrl('https://service.cluster.local/health')).toBeNull();
      expect(sanitizeUrl('https://router.lan/admin')).toBeNull();
    });

    it('strips user credentials from URLs', () => {
      const sanitized = sanitizeUrl('https://admin:secret@truthbounty.io/reports');
      expect(sanitized).toBe('https://truthbounty.io/reports');
      expect(sanitized).not.toContain('admin');
      expect(sanitized).not.toContain('secret');
    });
  });
});
