import { CacheUnavailableException } from './cache-unavailable.exception';

describe('CacheUnavailableException', () => {
  describe('forGet', () => {
    it('should create exception for GET operation', () => {
      const error = new Error('Redis connection failed');
      const exception = CacheUnavailableException.forGet('test:key', error);

      expect(exception).toBeInstanceOf(Error);
      expect(exception.name).toBe('CacheUnavailableException');
      expect(exception.message).toContain('Cache GET failed');
      expect(exception.message).toContain('test:key');
      expect(exception.operation).toBe('GET');
      expect(exception.key).toBe('test:key');
      expect(exception.originalError).toBe(error);
    });

    it('should create exception without original error', () => {
      const exception = CacheUnavailableException.forGet('test:key');

      expect(exception.operation).toBe('GET');
      expect(exception.key).toBe('test:key');
      expect(exception.originalError).toBeUndefined();
    });
  });

  describe('forSet', () => {
    it('should create exception for SET operation', () => {
      const error = new Error('Redis write failed');
      const exception = CacheUnavailableException.forSet('test:key', error);

      expect(exception.operation).toBe('SET');
      expect(exception.key).toBe('test:key');
      expect(exception.originalError).toBe(error);
    });
  });

  describe('forDelete', () => {
    it('should create exception for DELETE operation', () => {
      const error = new Error('Redis delete failed');
      const exception = CacheUnavailableException.forDelete('test:key', error);

      expect(exception.operation).toBe('DELETE');
      expect(exception.key).toBe('test:key');
      expect(exception.originalError).toBe(error);
    });
  });

  describe('forConnection', () => {
    it('should create exception for connection failure', () => {
      const error = new Error('Connection refused');
      const exception = CacheUnavailableException.forConnection(error);

      expect(exception.operation).toBe('CONNECTION');
      expect(exception.key).toBeUndefined();
      expect(exception.originalError).toBe(error);
    });
  });

  describe('constructor', () => {
    it('should create exception with custom message', () => {
      const exception = new CacheUnavailableException(
        'Custom error message',
        'CUSTOM_OP',
        'custom:key',
        new Error('Original error'),
      );

      expect(exception.message).toBe('Custom error message');
      expect(exception.operation).toBe('CUSTOM_OP');
      expect(exception.key).toBe('custom:key');
      expect(exception.originalError).toBeInstanceOf(Error);
    });
  });
});
