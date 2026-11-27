import {
  BadRequestException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { IpfsService } from '../../ipfs/ipfs.service';
import { PrepareEvidenceUploadDto } from './dto/prepare-evidence-upload.dto';

export const CANONICAL_CLAIM_IDENTITY = Symbol('CANONICAL_CLAIM_IDENTITY');

/**
 * Narrow port for validating that a claim id exists in the canonical V2
 * projection. Implementation lives with the read models; the preparation flow
 * only needs the fail-closed assertion.
 */
export interface CanonicalClaimIdentityPort {
  assertCanonicalClaim(claimId: string): Promise<void>;
}

export interface EvidenceUploadPreparation {
  preparationId: string;
  claimId: string;
  cid: string;
  size: number;
  gatewayUrl?: string;
  status: 'IPFS_CONTENT_PREPARED';
  onChainRegistered: false;
  evidenceRegistered: false;
  canonical: false;
  attestation: string;
  lifecycle: readonly string[];
  preparedAt: string;
}

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b0x[0-9a-fA-F]{64}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\b(?:seed\s*(?:phrase|words?)|mnemonic)\s*[:=]/i,
];

const LIFECYCLE: readonly string[] = [
  'IPFS content prepared by the API (non-authoritative).',
  'User submits a signed EvidenceRegistered/EvidenceReplaced transaction.',
  'Finalized canonical event is ingested and projected.',
  'V2 evidence read model becomes canonical.',
];

@Injectable()
export class EvidenceUploadPreparationService {
  constructor(
    @Inject(CANONICAL_CLAIM_IDENTITY)
    private readonly claimIdentity: CanonicalClaimIdentityPort,
    private readonly ipfs: IpfsService,
  ) {}

  /**
   * Prepare IPFS content for a canonical claim. This is a support operation
   * only: it writes no protocol table, emits no protocol event, and always
   * reports that no on-chain evidence registration has occurred.
   */
  async prepare(
    claimId: string,
    dto: PrepareEvidenceUploadDto,
  ): Promise<EvidenceUploadPreparation> {
    if (!CLAIM_ID_PATTERN.test(claimId ?? '')) {
      throw new BadRequestException('Invalid canonical claim id');
    }
    await this.claimIdentity.assertCanonicalClaim(claimId);

    const content = dto?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new BadRequestException('content must be a non-empty string');
    }
    if (
      dto.encoding !== undefined &&
      dto.encoding !== 'utf8' &&
      dto.encoding !== 'base64'
    ) {
      throw new BadRequestException('encoding must be utf8 or base64');
    }

    const buffer =
      dto.encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');
    if (buffer.length === 0 || buffer.length > MAX_CONTENT_BYTES) {
      throw new BadRequestException(
        `content must be between 1 and ${MAX_CONTENT_BYTES} bytes`,
      );
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Secret Material Detected',
        code: 'SECRET_BANNED',
        message:
          'Content was not stored or forwarded because it appears to contain secret material. Remove it and rotate any exposed secret.',
        canonical: false,
      });
    }

    const result = await this.ipfs.uploadBuffer(buffer, dto.filename);
    if (!result || typeof result.cid !== 'string' || result.cid.length === 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'IPFS preparation failed',
        code: 'IPFS_CID_MISSING',
        message: 'The IPFS provider did not return a content identifier.',
        canonical: false,
      });
    }

    // Deterministic for (claim, content): repeated uploads produce the same
    // identifier and no additional protocol state (IPFS is content-addressed).
    const preparationId = createHash('sha256')
      .update(`${claimId}:${result.cid}`)
      .digest('hex');

    return {
      preparationId,
      claimId,
      cid: result.cid,
      size: result.size ?? buffer.length,
      gatewayUrl: this.ipfs.getGatewayUrl(result.cid),
      status: 'IPFS_CONTENT_PREPARED',
      onChainRegistered: false,
      evidenceRegistered: false,
      canonical: false,
      attestation:
        'Non-authoritative IPFS preparation only. No claim or evidence was registered on-chain and no protocol state was written by the API.',
      lifecycle: LIFECYCLE,
      preparedAt: new Date().toISOString(),
    };
  }
}
