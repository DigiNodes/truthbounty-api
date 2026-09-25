import { redactSensitiveData, redactObject, generateRequestId } from './redaction.util';

describe('Redaction Utils', () => {
  describe('redactSensitiveData', () => {
    it('should redact passwords', () => {
      const input = 'password=secret123';
      const result = redactSensitiveData(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('secret123');
    });

    it('should redact tokens', () => {
      const input = 'token=eyJhbGciOiJIUzI1NiJ9.test';
      const result = redactSensitiveData(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    it('should redact credit card numbers', () => {
      const input = 'Card: 4111-1111-1111-1111';
      const result = redactSensitiveData(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('4111');
    });

    it('should return non-string inputs as strings', () => {
      const input = 12345;
      const result = redactSensitiveData(input);
      expect(result).toBe('12345');
    });

    it('should handle empty strings', () => {
      const input = '';
      const result = redactSensitiveData(input);
      expect(result).toBe('');
    });
  });

  describe('redactObject', () => {
    it('should redact sensitive keys', () => {
      const input = {
        username: 'john',
        password: 'secret',
        token: 'abc123',
      };
      const result = redactObject(input);
      expect(result).toEqual({
        username: 'john',
        password: '[REDACTED]',
        token: '[REDACTED]',
      });
    });

    it('should recursively redact nested objects', () => {
      const input = {
        user: {
          name: 'john',
          credentials: {
            password: 'secret',
          },
        },
      };
      const result = redactObject(input);
      expect(result.user.credentials.password).toBe('[REDACTED]');
      expect(result.user.name).toBe('john');
    });

    it('should handle arrays', () => {
      const input = [
        { password: 'secret1' },
        { password: 'secret2' },
      ];
      const result = redactObject(input);
      expect(result[0].password).toBe('[REDACTED]');
      expect(result[1].password).toBe('[REDACTED]');
    });

    it('should handle null and undefined', () => {
      expect(redactObject(null)).toBeNull();
      expect(redactObject(undefined)).toBeUndefined();
    });
  });

  describe('generateRequestId', () => {
    it('should generate a valid UUID', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should generate unique IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
    });
  });
});