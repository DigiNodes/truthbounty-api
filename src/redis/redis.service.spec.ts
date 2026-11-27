import { RedisService } from './redis.service';

describe('RedisService.setnx semantics (PREWAVE-BE-128)', () => {
  const service = new RedisService({ get: jest.fn() } as any);

  it('returns false when Redis is not connected', async () => {
    (service as any).client = null;
    (service as any).isConnected = false;

    await expect(service.setnx('key', 'value', 60)).resolves.toBe(false);
  });

  it('returns false when Redis rejects the command', async () => {
    (service as any).client = {
      set: jest.fn().mockRejectedValue(new Error('connection reset')),
    };
    (service as any).isConnected = true;

    await expect(service.setnx('key', 'value', 60)).resolves.toBe(false);
  });

  it('returns true only when Redis confirms a new key', async () => {
    (service as any).client = { set: jest.fn().mockResolvedValue('OK') };
    (service as any).isConnected = true;

    await expect(service.setnx('key', 'value', 60)).resolves.toBe(true);
  });
});
