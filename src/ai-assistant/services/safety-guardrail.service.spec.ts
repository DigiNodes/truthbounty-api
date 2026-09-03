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
});
