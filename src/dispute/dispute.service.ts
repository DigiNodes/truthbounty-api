import {
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';
import { DisputeJournalStore, DisputeWorkflow } from './dispute-journal.store';
import { DisputeProjectionService } from './dispute-projection.service';

export interface CreateDisputeDto {
  claimId: string;
  metadata?: Record<string, unknown>;
}
export interface FindAllDisputesDto {
  status?: string;
  trigger?: string;
  claimId?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class DisputeService {
  constructor(
    private readonly store: DisputeJournalStore,
    private readonly projection: DisputeProjectionService,
  ) {}

  private actor(principal?: AuthenticatedPrincipal): string {
    if (!principal || !/^0x[\da-f]{40}$/i.test(principal.address))
      throw new UnauthorizedException();
    return principal.address.toLowerCase();
  }

  private workflow(row: DisputeWorkflow) {
    return { ...row, authority: 'non_authoritative_workflow' as const };
  }

  async createDispute(
    dto: CreateDisputeDto,
    principal?: AuthenticatedPrincipal,
  ) {
    const actor = this.actor(principal);
    if (
      Object.keys(dto).some((key) => !['claimId', 'metadata'].includes(key))
    ) {
      throw new BadRequestException(
        'Only claimId and untrusted workflow metadata may be submitted',
      );
    }
    if (
      typeof dto.claimId !== 'string' ||
      !dto.claimId.trim() ||
      dto.claimId.length > 256
    )
      throw new BadRequestException('Invalid claimId');
    const metadata = dto.metadata ?? {};
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      JSON.stringify(metadata).length > 4096
    ) {
      throw new BadRequestException(
        'Workflow metadata must be an object of at most 4096 characters',
      );
    }
    const row = await this.store.create(
      this.projection.release(),
      dto.claimId,
      actor,
      metadata,
    );
    return { workflow: this.workflow(row) };
  }

  async review(
    id: string,
    principal: AuthenticatedPrincipal | undefined,
    status: string,
    reason?: string,
  ) {
    const actor = this.actor(principal);
    if (!['REVIEWING', 'ACCEPTED_FOR_REVIEW', 'DISMISSED'].includes(status))
      throw new BadRequestException('Invalid review status');
    if (
      reason !== undefined &&
      (typeof reason !== 'string' || reason.length > 2000)
    )
      throw new BadRequestException('Invalid review reason');
    const row = await this.store.review(
      this.projection.release(),
      id,
      actor,
      status,
      reason ?? null,
    );
    if (!row) throw new NotFoundException('Dispute workflow not found');
    return { workflow: this.workflow(row) };
  }

  startReview(id: string, principal?: AuthenticatedPrincipal) {
    return this.review(id, principal, 'REVIEWING');
  }

  /** Tombstones for HTTP and older internal callers. */
  resolveDispute(_dto?: unknown): never {
    throw new GoneException(
      'Local dispute resolution is retired; outcomes require finalized contract events',
    );
  }
  rejectDispute(_dto?: unknown): never {
    throw new GoneException(
      'Local dispute rejection is retired; use non-authoritative review metadata',
    );
  }
  expireDispute(_id?: string): never {
    throw new GoneException(
      'Only finalized contract events establish dispute expiry',
    );
  }

  async findAll(query: FindAllDisputesDto = {}) {
    const { limit = 50, offset = 0 } = query;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new BadRequestException('Invalid pagination');
    const snapshot = await this.projection.snapshot();
    const items = snapshot.items.filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.trigger || item.trigger === query.trigger) &&
        (!query.claimId || item.claimId === query.claimId),
    );
    return {
      ...snapshot,
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    };
  }

  async getDisputeByClaimId(claimId: string) {
    const snapshot = await this.projection.snapshot();
    const workflows = await this.store.workflows(this.projection.release());
    if (workflows.length > 10000)
      throw new BadRequestException('Workflow history exceeds supported bound');
    return {
      ...snapshot,
      items: snapshot.items.filter((item) => item.claimId === claimId),
      workflows: workflows
        .filter((item) => item.claimId === claimId)
        .map((item) => this.workflow(item)),
    };
  }

  getDisputeHistoryForClaim(claimId: string) {
    return this.getDisputeByClaimId(claimId);
  }
  getExpiredDisputes() {
    return this.findAll({ status: 'EXPIRED' });
  }
}
