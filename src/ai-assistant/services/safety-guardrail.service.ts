import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiConfig } from '../config/ai.config';

export interface RedactResult {
  text: string;
  redacted: boolean;
}

export interface ContentCheckResult {
  blocked: boolean;
  reason?: string;
}

const REDACTION_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'email', pattern: /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/g },
  { label: 'phone', pattern: /\+?\d[\d\-\s]{8,}\d/g },
  { label: 'credit_card', pattern: /\b(?:\d[ -]*?){13,19}\b/g },
  { label: 'openai_key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { label: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g },
  {
    label: 'jwt',
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  {
    label: 'pem_private_key',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

@Injectable()
export class SafetyGuardrailService {
  private readonly aiConfig: AiConfig;

  constructor(private readonly configService: ConfigService) {
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
  }

  /** Redacts emails, phone numbers, card numbers, and common secret formats. */
  redact(text: string): RedactResult {
    let redacted = false;
    let result = text;
    for (const { pattern } of REDACTION_PATTERNS) {
      if (pattern.test(result)) {
        redacted = true;
      }
      // reset lastIndex for global regexes reused across calls
      pattern.lastIndex = 0;
      result = result.replace(pattern, '[REDACTED]');
    }
    return { text: result, redacted };
  }

  /**
   * Blocklist/heuristic content filter. Runs before any provider call so a
   * match never reaches the model — zero-cost, deterministic refusal.
   */
  checkContent(text: string): ContentCheckResult {
    const lower = text.toLowerCase();

    for (const term of this.aiConfig.blockedTerms) {
      if (lower.includes(term.toLowerCase())) {
        return { blocked: true, reason: 'blocklist_match' };
      }
    }

    for (const heuristic of this.aiConfig.promptLeakHeuristics) {
      if (lower.includes(heuristic.toLowerCase())) {
        return { blocked: true, reason: 'prompt_injection_heuristic' };
      }
    }

    return { blocked: false };
  }

  isWithinLengthLimit(text: string): boolean {
    return text.length <= this.aiConfig.maxPromptLength;
  }

  /**
   * Checks whether the model's raw output leaked the per-request canary
   * token embedded in the system prompt — the concrete, testable stand-in
   * for "don't let the model reveal its system prompt."
   */
  containsCanaryLeak(output: string, canaryToken: string): boolean {
    return output.includes(canaryToken);
  }

  generateCanaryToken(): string {
    return `cnry_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  readonly REFUSAL_MESSAGE =
    "I can't help with that request. If you think this is a mistake, please rephrase and try again.";

  readonly LEAK_REFUSAL_MESSAGE =
    "I can't share that. Let me know if there's something else about TruthBounty I can help with.";
}
