import {
  assertBoundedFailure,
  assertFailClosed,
  assertIdempotentRecovery,
} from '../harness/recovery-assertions';

describe('V2-BE-087 recovery assertions', () => {
  it('accepts bounded, redacted failures', () => {
    expect(() =>
      assertBoundedFailure(
        {
          completed: false,
          duplicateEffects: 0,
          retryCount: 2,
          errorMessage: 'RPC request timed out',
        },
        3,
      ),
    ).not.toThrow();
  });

  it('rejects retry-budget exhaustion', () => {
    expect(() =>
      assertBoundedFailure(
        {
          completed: false,
          duplicateEffects: 0,
          retryCount: 4,
        },
        3,
      ),
    ).toThrow('Retry budget exceeded');
  });

  it('rejects sensitive error disclosure', () => {
    expect(() =>
      assertBoundedFailure(
        {
          completed: false,
          duplicateEffects: 0,
          errorMessage: 'token=super-secret',
        },
        3,
      ),
    ).toThrow('Sensitive material');
  });

  it('rejects duplicate side effects', () => {
    expect(() =>
      assertIdempotentRecovery({
        completed: true,
        duplicateEffects: 1,
      }),
    ).toThrow('duplicate effects');
  });

  it('fails closed for untrusted chain input', () => {
    expect(() =>
      assertFailClosed({
        completed: false,
        duplicateEffects: 0,
        finalizedFromUntrustedInput: true,
      }),
    ).toThrow('Untrusted chain input');
  });
});
