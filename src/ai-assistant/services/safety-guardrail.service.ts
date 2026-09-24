import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SafetyGuardrailService {
  private readonly logger = new Logger(SafetyGuardrailService.name);
  private readonly blocklist = ['bomb', 'malware', 'hack'];

  checkContent(content: string): { flagged: boolean; reason?: string } {
    const lowerContent = content.toLowerCase();
    for (const term of this.blocklist) {
      if (lowerContent.includes(term)) {
        this.logger.warn(`Content flagged for: ${term}`);
        return { flagged: true, reason: 'blocklist_match' };
      }
    }
    return { flagged: false };
  }
}
