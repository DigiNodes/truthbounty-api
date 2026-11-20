import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';

export interface SupportRequestRecord {
  id: string;
  reference: string;
  category: string;
  contact: string;
  description: string;
  release?: string;
  diagnostics: string[];
  status: 'submitted' | 'duplicate' | 'expired' | 'deleted';
  duplicate: boolean;
  duplicateOf?: string | null;
  createdAt: string;
  expiresAt: string;
  retentionDays: number;
}

export interface SupportStaffActor {
  address?: string;
  userId?: string;
  sub?: string;
  user?: {
    id?: string;
    role?: string;
  };
}

export interface SupportRequestSubmission {
  reference: string;
  status: 'submitted' | 'duplicate';
  duplicate: boolean;
}

@Injectable()
export class SupportRequestService {
  private readonly logger = new Logger(SupportRequestService.name);
  private readonly retentionDays = 30;
  private readonly maxRequestsPerContact = 5;
  private readonly duplicateWindowMs = 24 * 60 * 60 * 1000;
  private readonly requests = new Map<string, SupportRequestRecord>();
  private readonly fingerprints = new Map<string, SupportRequestRecord>();

  createSupportRequest(input: CreateSupportRequestDto): SupportRequestSubmission {
    const normalized = this.normalizeRequest(input);
    const fingerprint = this.computeFingerprint(normalized);

    const duplicate = this.findDuplicate(fingerprint);
    if (duplicate) {
      this.logger.warn(
        'Duplicate support request suppressed',
      );
      return {
        reference: duplicate.reference,
        status: 'duplicate',
        duplicate: true,
      };
    }

    this.assertQuota(normalized.contact);

    const now = new Date();
    const record: SupportRequestRecord = {
      id: randomUUID(),
      reference: `SUP-${now.getTime().toString(36).toUpperCase()}`,
      category: normalized.category,
      contact: normalized.contact,
      description: normalized.description,
      release: normalized.release,
      diagnostics: normalized.diagnostics,
      status: 'submitted',
      duplicate: false,
      duplicateOf: null,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
      retentionDays: this.retentionDays,
    };

    this.requests.set(record.id, record);
    this.fingerprints.set(fingerprint, record);
    return {
      reference: record.reference,
      status: 'submitted',
      duplicate: false,
    };
  }

  getSupportRequest(
    id: string,
    actor: SupportStaffActor,
  ): SupportRequestRecord | undefined {
    this.assertSupportStaff(actor);
    this.audit('read', id, actor);
    return this.requests.get(id);
  }

  listSupportRequests(actor: SupportStaffActor): SupportRequestRecord[] {
    this.assertSupportStaff(actor);
    const records = Array.from(this.requests.values());
    this.audit('list', `${records.length} records`, actor);
    return records;
  }

  deleteSupportRequest(id: string, actor: SupportStaffActor): boolean {
    this.assertSupportStaff(actor);
    const record = this.requests.get(id);
    if (!record) {
      this.audit('delete-miss', id, actor);
      return false;
    }

    this.requests.delete(id);
    for (const [fingerprint, matched] of this.fingerprints.entries()) {
      if (matched.id === id) this.fingerprints.delete(fingerprint);
    }
    this.audit('delete', id, actor);
    return true;
  }

  cleanupExpiredSupportRequests(): string[] {
    const expiredIds: string[] = [];
    const now = Date.now();

    for (const [id, record] of this.requests.entries()) {
      if (new Date(record.expiresAt).getTime() <= now) {
        expiredIds.push(id);
        this.requests.delete(id);
      }
    }

    return expiredIds;
  }

  private normalizeRequest(input: CreateSupportRequestDto): Required<Pick<CreateSupportRequestDto, 'category' | 'contact' | 'description' | 'release'>> & {
      diagnostics: string[];
    } {
    const description = this.filteredText(input.description);
    const category = this.filteredText(input.category).toLowerCase();
    const contact = this.filteredText(input.contact).trim();
    const release = input.release ? this.filteredText(input.release) : undefined;
    const diagnostics = (input.diagnostics ?? [])
      .map((item) => this.filteredText(item))
      .filter(Boolean)
      .map((item) => this.assertSafeDiagnostic(item))
      .slice(0, 10);

    this.assertNoSensitiveContent(
      `${category} ${contact} ${description} ${release ?? ''} ${diagnostics.join(' ')}`,
    );

    return {
      category: category as string,
      contact,
      description,
      release,
      diagnostics,
    };
  }

  private assertQuota(contact: string): void {
    const recent = Array.from(this.requests.values()).filter((record) => {
      if (record.contact !== contact) return false;
      const age = Date.now() - new Date(record.createdAt).getTime();
      return age <= this.duplicateWindowMs;
    });

    if (recent.length >= this.maxRequestsPerContact) {
      throw new BadRequestException(
        'Support request quota exceeded. Please wait before submitting another request for this contact.',
      );
    }
  }

  private findDuplicate(fingerprint: string): SupportRequestRecord | undefined {
    const existing = this.fingerprints.get(fingerprint);
    if (!existing) return undefined;

    const age = Date.now() - new Date(existing.createdAt).getTime();
    if (age > this.duplicateWindowMs) {
      this.fingerprints.delete(fingerprint);
      return undefined;
    }

    return existing;
  }

  private computeFingerprint(input: {
    category: string;
    contact: string;
    description: string;
    release?: string;
    diagnostics: string[];
  }): string {
    const normalized = JSON.stringify({
      category: input.category,
      contact: input.contact.toLowerCase(),
      description: input.description.trim(),
      release: input.release?.trim() ?? '',
      diagnostics: [...input.diagnostics].sort(),
    });
    return Buffer.from(normalized).toString('base64url');
  }

  private assertSafeDiagnostic(value: string): string {
    const diagnostic = this.filteredText(value);
    if (!diagnostic) return diagnostic;

    const allowedPrefixes = [
      'requestId',
      'traceId',
      'release',
      'claimId',
      'issue',
      'build',
      'errorCode',
      'tenantId',
      'deviceId',
      'sessionId',
    ];

    const prefix = diagnostic.split(':', 1)[0]?.trim();
    if (!prefix || !allowedPrefixes.includes(prefix)) {
      throw new BadRequestException(
        'Support request rejected: diagnostics must use approved, non-sensitive reference keys only.',
      );
    }

    if (/\b(?:private key|secret|token|seed phrase|mnemonic|password|authorization)\b/i.test(diagnostic)) {
      throw new BadRequestException(
        'Support request rejected: contains sensitive or non-public content that cannot be stored.',
      );
    }

    return diagnostic;
  }

  private assertNoSensitiveContent(value: string): void {
    const candidate = value.toLowerCase();
    const prohibitedPatterns = [
      /seed phrase|mnemonic/i,
      /private key|wallet private key|secret key/i,
      /wallet password|password[:=]|api[_ -]?key|access token|refresh token/i,
      /bearer token|authorization[:=]|jwt\s*[:=]/i,
      /-----begin (?:rsa |ec )?private key-----/i,
      /0x[a-f0-9]{32,64}/i,
      /signature[:=]\s*0x[a-f0-9]+/i,
      /protected rationale|internal evidence|non-public evidence|do not share publicly/i,
    ];

    for (const pattern of prohibitedPatterns) {
      if (pattern.test(candidate)) {
        throw new BadRequestException(
          'Support request rejected: contains sensitive or non-public content that cannot be stored.',
        );
      }
    }
  }

  private filteredText(value: string | undefined): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  private assertSupportStaff(actor: SupportStaffActor): void {
    if (!['moderator', 'admin'].includes(actor?.user?.role ?? '')) {
      throw new ForbiddenException('Support staff access required');
    }
  }

  private audit(action: string, target: string, actor: SupportStaffActor): void {
    const actorId =
      actor.userId ?? actor.user?.id ?? actor.sub ?? 'authenticated-staff';
    this.logger.log(`Support request ${action}; actor=${actorId}; target=${target}`);
  }
}
