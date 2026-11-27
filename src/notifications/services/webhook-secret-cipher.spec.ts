import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { WebhookSecretCipher } from './webhook-secret-cipher.service';

const keyA = Buffer.from('a'.repeat(32), 'utf8').toString('base64url');
const keyB = Buffer.from('b'.repeat(32), 'utf8').toString('base64url');

function config(values: Record<string, string>, nodeEnv = 'test'): ConfigService {
  return {
    get: jest.fn((key: string) => values[key] ?? (key === 'NODE_ENV' ? nodeEnv : undefined)),
  } as unknown as ConfigService;
}

describe('WebhookSecretCipher', () => {
  afterEach(() => jest.restoreAllMocks());

  it('encrypts secrets at rest and never embeds the plaintext in the envelope', () => {
    const cipher = new WebhookSecretCipher(
      config({
        WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA }),
        WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v1',
      }),
    );

    const secret = 'canary-webhook-signing-secret-value';
    const stored = cipher.encrypt(secret);

    expect(stored.startsWith('whsec1.')).toBe(true);
    expect(stored).not.toContain(secret);
    expect(cipher.decrypt(stored)).toBe(secret);
  });

  it('uses a fresh IV so equal secrets produce different ciphertexts', () => {
    const cipher = new WebhookSecretCipher(
      config({ WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA }), WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v1' }),
    );
    expect(cipher.encrypt('same-secret')).not.toBe(cipher.encrypt('same-secret'));
  });

  it('fails closed on tampering', () => {
    const cipher = new WebhookSecretCipher(
      config({ WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA }), WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v1' }),
    );
    const stored = cipher.encrypt('secret-value');
    const parts = stored.split('.');
    parts[4] = `${parts[4].slice(0, -1)}A`;
    expect(() => cipher.decrypt(parts.join('.'))).toThrow(
      'Stored webhook secret could not be decrypted',
    );
  });

  it('supports key rotation: old envelopes decrypt with a retained previous key', () => {
    const oldCipher = new WebhookSecretCipher(
      config({ WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA }), WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v1' }),
    );
    const storedWithV1 = oldCipher.encrypt('rotated-secret');

    const newCipher = new WebhookSecretCipher(
      config({
        WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA, v2: keyB }),
        WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v2',
      }),
    );

    expect(newCipher.decrypt(storedWithV1)).toBe('rotated-secret');
    const storedWithV2 = newCipher.encrypt('rotated-secret');
    expect(storedWithV2.split('.')[1]).toBe(Buffer.from('v2', 'utf8').toString('base64url'));
    expect(newCipher.decrypt(storedWithV2)).toBe('rotated-secret');
    expect(() => oldCipher.decrypt(storedWithV2)).toThrow(
      'Webhook secret encryption key is unavailable',
    );
  });

  it('fails closed on unknown key IDs and invalid key material', () => {
    expect(
      () =>
        new WebhookSecretCipher(
          config({ WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA }), WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v9' }),
        ),
    ).toThrow('has no matching key');
    expect(
      () => new WebhookSecretCipher(config({ WEBHOOK_SECRET_KEYS: '{invalid' })),
    ).toThrow('must be a JSON object');
    expect(
      () => new WebhookSecretCipher(config({ WEBHOOK_SECRET_KEY: 'too-short' })),
    ).toThrow('must be 32 bytes');
  });

  it('refuses to start in production or staging without a configured keyring', () => {
    for (const nodeEnv of ['production', 'staging']) {
      expect(() => new WebhookSecretCipher(config({}, nodeEnv))).toThrow('Refusing to start');
    }
  });

  it('never logs the secret value', () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const cipher = new WebhookSecretCipher(
      config({ WEBHOOK_SECRET_KEYS: JSON.stringify({ v1: keyA }), WEBHOOK_SECRET_ACTIVE_KEY_ID: 'v1' }),
    );
    const stored = cipher.encrypt('never-log-this-secret');
    cipher.decrypt(stored);
    const logOutput = [...debug.mock.calls, ...warn.mock.calls].map((call) =>
      JSON.stringify(call),
    );
    expect(logOutput.join('\n')).not.toContain('never-log-this-secret');
  });
});
