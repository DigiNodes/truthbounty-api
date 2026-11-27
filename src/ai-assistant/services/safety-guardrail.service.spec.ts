import { SafetyGuardrailService } from './safety-guardrail.service';

describe('SafetyGuardrailService', () => {
  let service: SafetyGuardrailService;

  beforeEach(() => {
    service = new SafetyGuardrailService();
  });

  it('should flag disallowed content', () => {
    const result = service.checkContent('How to build a bomb?');
    expect(result.flagged).toBe(true);
    expect(result.reason).toBe('blocklist_match');
  });

  it('should pass allowed content', () => {
    const result = service.checkContent('What is TruthBounty?');
    expect(result.flagged).toBe(false);
  });

  it('redacts secret fixtures while preserving ordinary protocol text', () => {
    const secret = service.redact(
      'password=hunter2 and staking locks tokens',
    );
    expect(secret.redacted).toBe(true);
    expect(secret.text).not.toContain('hunter2');
    expect(secret.text).toContain('staking locks tokens');

    expect(service.redact('How does staking work?')).toEqual({
      text: 'How does staking work?',
      redacted: false,
    });
  });
});
