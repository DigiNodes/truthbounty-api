import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PublicIncidentProjectionEntity } from './entities/public-incident-projection.entity';
import {
  PublicIncidentComponent,
  PublicIncidentDetailDto,
  PublicIncidentImpact,
  PublicIncidentListResponseDto,
  PublicIncidentQueryDto,
  PublicIncidentStatus,
} from './public-incidents.dto';
import {
  PUBLIC_INCIDENT_OPTIONS,
  PublicIncidentOptions,
  loadPublicIncidentOptions,
} from './public-incidents.options';
import {
  projectPublicIncidentDetail,
  projectPublicIncidentList,
} from './public-incidents.projector';
import { sanitizeMarkdown, sanitizeUrl } from './public-incidents.sanitizer';

export interface PublishIncidentInput {
  incidentId?: string;
  slug?: string;
  title: string;
  status: PublicIncidentStatus;
  impact: PublicIncidentImpact;
  affectedComponents: PublicIncidentComponent[];
  description: string;
  mitigation?: string | null;
  postIncidentLinks?: Array<{ title: string; url: string }> | null;
  updateMessage?: string;
  isDraft?: boolean;
  adminId?: string;
}

@Injectable()
export class PublicIncidentService {
  private readonly logger = new Logger(PublicIncidentService.name);
  private readonly options: PublicIncidentOptions;

  constructor(
    @Optional()
    @InjectRepository(PublicIncidentProjectionEntity)
    private readonly incidentRepo?: Repository<PublicIncidentProjectionEntity>,
    @Optional()
    @Inject(PUBLIC_INCIDENT_OPTIONS)
    options?: PublicIncidentOptions,
    @Optional() private readonly clock: () => Date = () => new Date(),
  ) {
    this.options = options ?? loadPublicIncidentOptions();
  }

  getOptions(): PublicIncidentOptions {
    return this.options;
  }

  /**
   * Retrieves a paginated list of published incidents.
   * Only approved, non-draft records are published.
   */
  async findAll(
    query: PublicIncidentQueryDto,
  ): Promise<{ body: PublicIncidentListResponseDto; maxAgeSeconds: number }> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const now = this.clock();

    if (!this.incidentRepo) {
      // Standalone or unconfigured backing store: fail closed safely
      return {
        body: projectPublicIncidentList([], 0, page, limit, now, {
          staleAfterSeconds: this.options.staleAfterSeconds,
        }),
        maxAgeSeconds: this.options.cacheTtlSeconds,
      };
    }

    try {
      const qb = this.incidentRepo
        .createQueryBuilder('p')
        .where('p.isApproved = :isApproved', { isApproved: true })
        .andWhere('p.isDraft = :isDraft', { isDraft: false });

      if (query.status) {
        qb.andWhere('p.status = :status', { status: query.status });
      }

      if (query.component) {
        // Query json column contains component
        qb.andWhere(`p.affectedComponents LIKE :comp`, {
          comp: `%${query.component}%`,
        });
      }

      qb.orderBy('p.updatedAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);

      const [records, total] = await qb.getManyAndCount();

      const body = projectPublicIncidentList(
        records,
        total,
        page,
        limit,
        now,
        {
          staleAfterSeconds: this.options.staleAfterSeconds,
        },
      );

      return { body, maxAgeSeconds: this.options.cacheTtlSeconds };
    } catch (err: any) {
      this.logger.error('Failed to query public incidents store', err?.message);
      throw new ServiceUnavailableException('Public incident data is temporarily unavailable.');
    }
  }

  /**
   * Retrieves sanitized public incident detail by public ID or slug.
   * Fails closed: unapproved or draft records return 404.
   */
  async findById(
    id: string,
  ): Promise<{ body: PublicIncidentDetailDto; maxAgeSeconds: number }> {
    if (!this.incidentRepo) {
      throw new NotFoundException(`Incident with ID ${id} not found`);
    }

    let record: PublicIncidentProjectionEntity | null = null;
    try {
      record = await this.incidentRepo
        .createQueryBuilder('p')
        .where('(p.id = :id OR p.slug = :id OR p.incidentId = :id)', { id })
        .andWhere('p.isApproved = :isApproved', { isApproved: true })
        .andWhere('p.isDraft = :isDraft', { isDraft: false })
        .getOne();
    } catch (err: any) {
      this.logger.error(`Error querying incident ${id}`, err?.message);
      throw new ServiceUnavailableException('Public incident data is temporarily unavailable.');
    }

    if (!record) {
      throw new NotFoundException(`Incident with ID ${id} not found`);
    }

    const detail = projectPublicIncidentDetail(record);
    if (!detail) {
      throw new NotFoundException(`Incident with ID ${id} not found`);
    }

    return { body: detail, maxAgeSeconds: this.options.cacheTtlSeconds };
  }

  /**
   * Admin-facing: publishes or updates a public incident projection.
   */
  async publishProjection(
    input: PublishIncidentInput,
  ): Promise<PublicIncidentDetailDto> {
    if (!this.incidentRepo) {
      throw new ServiceUnavailableException('Public incident store is not configured');
    }

    const now = this.clock();
    const isDraft = input.isDraft === true;
    const isApproved = !isDraft;

    // Look for existing projection by incidentId or id
    let entity: PublicIncidentProjectionEntity | null = null;
    if (input.incidentId) {
      entity = await this.incidentRepo.findOne({
        where: [{ incidentId: input.incidentId }, { id: input.incidentId }],
      });
    }

    const sanitizedTitle = sanitizeMarkdown(input.title);
    const sanitizedDesc = sanitizeMarkdown(input.description);
    const sanitizedMitigation = input.mitigation
      ? sanitizeMarkdown(input.mitigation)
      : null;

    const sanitizedLinks = Array.isArray(input.postIncidentLinks)
      ? input.postIncidentLinks
          .map((l) => ({
            title: sanitizeMarkdown(l.title),
            url: sanitizeUrl(l.url) ?? '',
          }))
          .filter((l) => Boolean(l.url))
      : [];

    const existingHistory = entity?.publicationHistory ?? [];
    const newSeq = (entity?.publicationSequence ?? 0) + (isApproved ? 1 : 0);

    const historyRecord = isApproved && input.updateMessage
      ? {
          id: `pub-${now.getTime()}-${newSeq}`,
          status: input.status,
          message: sanitizeMarkdown(input.updateMessage),
          publishedAt: now.toISOString(),
          affectedComponents: input.affectedComponents,
        }
      : null;

    const publicationHistory = historyRecord
      ? [...existingHistory, historyRecord]
      : existingHistory;

    if (!entity) {
      entity = this.incidentRepo.create({
        incidentId: input.incidentId ?? null,
        slug: input.slug ?? null,
        title: sanitizedTitle,
        status: input.status,
        impact: input.impact,
        affectedComponents: input.affectedComponents,
        description: sanitizedDesc,
        mitigation: sanitizedMitigation,
        postIncidentLinks: sanitizedLinks,
        publicationHistory,
        isApproved,
        isDraft,
        approvedBy: isApproved ? input.adminId ?? null : null,
        approvedAt: isApproved ? now : null,
        publicationSequence: newSeq,
        startedAt: now,
        publishedAt: isApproved ? now : null,
        resolvedAt: input.status === 'resolved' ? now : null,
      });
    } else {
      entity.title = sanitizedTitle;
      entity.status = input.status;
      entity.impact = input.impact;
      entity.affectedComponents = input.affectedComponents;
      entity.description = sanitizedDesc;
      if (sanitizedMitigation !== undefined) {
        entity.mitigation = sanitizedMitigation;
      }
      if (input.postIncidentLinks !== undefined) {
        entity.postIncidentLinks = sanitizedLinks;
      }
      entity.publicationHistory = publicationHistory;
      entity.isApproved = isApproved;
      entity.isDraft = isDraft;
      if (isApproved) {
        entity.approvedBy = input.adminId ?? entity.approvedBy;
        entity.approvedAt = now;
        entity.publishedAt = entity.publishedAt ?? now;
        entity.publicationSequence = newSeq;
      }
      if (input.status === 'resolved' && !entity.resolvedAt) {
        entity.resolvedAt = now;
      } else if (input.status !== 'resolved') {
        entity.resolvedAt = null;
      }
    }

    const saved = await this.incidentRepo.save(entity);
    const detail = projectPublicIncidentDetail(saved);
    if (!detail) {
      throw new Error('Failed to project saved incident');
    }
    return detail;
  }
}
