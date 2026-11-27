import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThan } from 'typeorm';
import { randomUUID } from 'crypto';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';
import { SupportRequest } from './entities/support-request.entity';
import { SupportEncryptionService } from './support-encryption.service';

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

  constructor(
    @InjectRepository(SupportRequest)
    private readonly supportRequestRepository: Repository<SupportRequest>,
    private readonly encryptionService: SupportEncryptionService,
  ) {}

  async createSupportRequest(
    input: CreateSupportRequestDto,
  ): Promise<SupportRequestSubmission> {
    const normalized = this.normalizeRequest(input);
    const fingerprintKey = this.encryptionService.computeFingerprintKey(normalized);

    // Check for duplicate by fingerprint (atomic via unique constraint)
    const duplicate = await this.findDuplicate(fingerprintKey);
    if (duplicate) {
      this.logger.warn('Duplicate support request suppressed');
      return {
        reference: duplicate.reference,
        status: 'duplicate',
        duplicate: true,
      };
    }

    // Check quota for this contact (need to decrypt and compare)
    await this.assertQuota(normalized.contact);

    const now = new Date();
    const id = randomUUID();
    const reference = `SUP-${now.getTime().toString(36).toUpperCase()}`;

    // Encrypt sensitive fields
    const encryptedContact = this.encryptionService.encrypt(normalized.contact);
    const encryptedDescription = this.encryptionService.encrypt(
      normalized.description,
    );

    const entity = this.supportRequestRepository.create({
      id,
      reference,
      category: normalized.category,
      encryptedContact,
      encryptedDescription,
      release: normalized.release,
      diagnostics: normalized.diagnostics,
      fingerprintKey,
      status: 'submitted',
      duplicate: false,
      duplicateOf: null,
      expiresAt: new Date(
        now.getTime() + this.retentionDays * 24 * 60 * 60 * 1000,
      ),
      retentionDays: this.retentionDays,
    });

    try {
      await this.supportRequestRepository.save(entity);
      this.logger.log(`Support request created: ${reference}`);
      return {
        reference,
        status: 'submitted',
        duplicate: false,
      };
    } catch (error) {
      // Handle unique constraint violation (race condition on duplicate)
      if (error.code === '23505' && error.constraint === 'UQ_support_requests_fingerprintKey') {
        this.logger.warn('Duplicate support request detected on save (race condition)');
        const existing = await this.supportRequestRepository.findOne({
          where: { fingerprintKey },
        });
        if (existing) {
          return {
            reference: existing.reference,
            status: 'duplicate',
            duplicate: true,
          };
        }
      }
      throw error;
    }
  }

  async getSupportRequest(
    id: string,
    actor: SupportStaffActor,
  ): Promise<SupportRequestRecord | undefined> {
    this.assertSupportStaff(actor);
    this.audit('read', id, actor);

    const entity = await this.supportRequestRepository.findOne({
      where: { id },
    });

    if (!entity) {
      return undefined;
    }

    return this.decryptRecord(entity);
  }

  async listSupportRequests(
    actor: SupportStaffActor,
  ): Promise<SupportRequestRecord[]> {
    this.assertSupportStaff(actor);

    const entities = await this.supportRequestRepository.find({
      order: { createdAt: 'DESC' },
      take: 100, // Limit to prevent unbounded queries
    });

    this.audit('list', `${entities.length} records`, actor);

    return entities.map((entity) => this.decryptRecord(entity));
  }

  async deleteSupportRequest(id: string, actor: SupportStaffActor): Promise<boolean> {
    this.assertSupportStaff(actor);

    const entity = await this.supportRequestRepository.findOne({
      where: { id },
    });

    if (!entity) {
      this.audit('delete-miss', id, actor);
      return false;
    }

    await this.supportRequestRepository.remove(entity);
    this.audit('delete', id, actor);
    return true;
  }

  async cleanupExpiredSupportRequests(): Promise<string[]> {
    const now = new Date();

    // Find expired records
    const expired = await this.supportRequestRepository.find({
      where: {
        expiresAt: LessThanOrEqual(now),
        status: 'submitted', // Only clean up active records
      },
      select: ['id', 'reference'],
    });

    if (expired.length === 0) {
      return [];
    }

    const expiredIds = expired.map((r) => r.id);
    const expiredRefs = expired.map((r) => r.reference);

    // Delete expired records
    await this.supportRequestRepository.delete({
      id: expiredIds as any,
    });

    this.logger.log(
      `Cleaned up ${expiredIds.length} expired support requests: ${expiredRefs.join(', ')}`,
    );

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

  private async assertQuota(contact: string): Promise<void> {
    // Since contact is encrypted, we need to fetch recent requests and decrypt
    // to check quota. This is less efficient than indexing plaintext but
    // preserves privacy.
    const cutoff = new Date(Date.now() - this.duplicateWindowMs);

    const recentRequests = await this.supportRequestRepository.find({
      where: {
        createdAt: MoreThan(cutoff),
        status: 'submitted',
      },
      select: ['id', 'encryptedContact'],
    });

    // Decrypt and count matching contacts
    let matchCount = 0;
    for (const req of recentRequests) {
      try {
        const decryptedContact = this.encryptionService.decrypt(
          req.encryptedContact,
        );
        if (decryptedContact === contact) {
          matchCount++;
        }
      } catch (error) {
        // Skip records that fail to decrypt (corruption or key rotation)
        this.logger.warn(
          `Failed to decrypt contact for quota check: ${req.id}`,
        );
      }
    }

    if (matchCount >= this.maxRequestsPerContact) {
      throw new BadRequestException(
        'Support request quota exceeded. Please wait before submitting another request for this contact.',
      );
    }
  }

  private async findDuplicate(
    fingerprintKey: string,
  ): Promise<SupportRequest | undefined> {
    const existing = await this.supportRequestRepository.findOne({
      where: { fingerprintKey },
    });

    if (!existing) {
      return undefined;
    }

    const age = Date.now() - new Date(existing.createdAt).getTime();
    if (age > this.duplicateWindowMs) {
      // Expired duplicate - remove it
      await this.supportRequestRepository.delete({ id: existing.id });
      return undefined;
    }

    return existing;
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

  /**
   * Decrypt a SupportRequest entity into a SupportRequestRecord.
   * Omits encrypted fields from logs and returns decrypted contact/description.
   */
  private decryptRecord(entity: SupportRequest): SupportRequestRecord {
    try {
      const contact = this.encryptionService.decrypt(entity.encryptedContact);
      const description = this.encryptionService.decrypt(
        entity.encryptedDescription,
      );

      return {
        id: entity.id,
        reference: entity.reference,
        category: entity.category,
        contact,
        description,
        release: entity.release,
        diagnostics: entity.diagnostics,
        status: entity.status,
        duplicate: entity.duplicate,
        duplicateOf: entity.duplicateOf,
        createdAt: entity.createdAt.toISOString(),
        expiresAt: entity.expiresAt.toISOString(),
        retentionDays: entity.retentionDays,
      };
    } catch (error) {
      this.logger.error(
        `Failed to decrypt support request ${entity.id}: ${error.message}`,
      );
      throw new Error('Failed to decrypt support request data');
    }
  }
}
