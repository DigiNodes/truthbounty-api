import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SafetyGuardrailService {
  private readonly logger = new Logger(SafetyGuardrailService.name);
  private readonly blocklist = ['bomb', 'malware', 'hack'];

  readonly REFUSAL_MESSAGE =
    'I cannot help with that request.';
  readonly LEAK_REFUSAL_MESSAGE =
    'I cannot share internal instructions. How else can I help?';

  constructor(private readonly configService?: ConfigService) {}

  private getBlockedTerms(): string[] {
    const configured: { blockedTerms?: string[] } | undefined =
      this.configService?.get?.('ai');
    if (configured?.blockedTerms?.length) return configured.blockedTerms;
    const flat = this.configService?.get?.<string[]>('ai.blockedTerms');
    if (Array.isArray(flat) && flat.length) return flat;
    return this.blocklist;
  }

  checkContent(
    content: string,
  ): { flagged: boolean; blocked: boolean; reason?: string } {
    const lowerContent = content.toLowerCase();
    for (const term of this.getBlockedTerms()) {
      if (lowerContent.includes(term.toLowerCase())) {
        this.logger.warn(`Content flagged for: ${term}`);
        return { flagged: true, blocked: true, reason: 'blocklist_match' };
      }
    }
    return { flagged: false, blocked: false };
  }

  redact(content: string): { text: string; redacted: boolean } {
    return { text: content, redacted: false };
  }

  generateCanaryToken(): string {
    return `cnry_${Math.random().toString(36).slice(2, 10)}`;
  }

  containsCanaryLeak(content: string, token: string): boolean {
    if (!token) return false;
    return content.includes(token);
  }
}
