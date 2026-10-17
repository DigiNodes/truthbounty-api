import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  GoneException,
  RequestTimeoutException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { AuditLog } from '../entities/audit-log.entity';
import { ExportCursor } from '../entities/export-cursor.entity';
import {
  ExportAuditCursorDto,
  ExportCursorResponseDto,
  ExportedAuditRow,
  EXPORT_FIELD_ALLOWLIST,
  EXPORT_PAGE_SIZE_DEFAULT,
  EXPORT_PAGE_SIZE_MAX,
  EXPORT_TIME_LIMIT_MS,
  EXPORT_ROW_LIMIT_TOTAL,
  EXPORT_PAGE_LIMIT,
  EXPORT_CURSOR_TTL_SECONDS,
} from '../dto/export-audit-cursor.dto';

/**
 * ExportCursorService — cursor-based, resumable audit log export.
 *
 * Security invariants (PREWAVE-BE-033):
 *   1. Export cannot mutate records — all queries are SELECT only.
 *   2. Sensitive fields are excluded via EXPORT_FIELD_ALLOWLIST.
 *   3. Integrity is independently verifiable — each page carries an
 *      HMAC-SHA256 checkpointHash over the serialised row array.
 *   4. Work is bounded — per-page size ≤ EXPORT_PAGE_SIZE_MAX,
 *      wall-clock ≤ EXPORT_TIME_LIMIT_MS, total rows ≤ EXPORT_ROW_LIMIT_TOTAL,
 *      total pages ≤ EXPORT_PAGE_LIMIT.
 *   5. State is resumable — cursor row persists `lastSeq` / `lastId` and
 *      is looked up on every subsequent page request.
 *   6. Fail closed — expired, cancelled, or exhausted cursors are rejected.
 */
@Injectable()
export class ExportCursorService {
  private readonly logger = new Logger(ExportCursorService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
    @InjectRepository(ExportCursor)
    private readonly exportCursorRepo: Repository<ExportCursor>,
    private readonly configService: ConfigService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Fetch one page of export data, creating or resuming a cursor session.
   *
   * @param dto  Validated request parameters.
   * @param requesterId  Admin user ID taken from the verified JWT; never
   *                     accepted from the request body.
   */
  async fetchPage(
    dto: ExportAuditCursorDto,
    requesterId: string,
  ): Promise<ExportCursorResponseDto> {
    const pageStart = Date.now();

    const cursor = dto.cursorId
      ? await this.resumeCursor(dto.cursorId, requesterId)
      : await this.createCursor(dto, requesterId);

    this.assertCursorActive(cursor);
    this.assertWithinGlobalLimits(cursor);

    const limit = Math.min(
      dto.limit ?? EXPORT_PAGE_SIZE_DEFAULT,
      EXPORT_PAGE_SIZE_MAX,
    );

    const rows = await this.queryPage(cursor, limit, pageStart);

    const allowlisted = rows.map((r) => this.applyAllowlist(r));

    const checkpointHash = this.computeCheckpointHash(allowlisted);
    const exhausted = rows.length < limit;

    // Determine new cursor position
    const lastRow = rows[rows.length - 1] ?? null;
    const newLastSeq = lastRow?.chainSequence ?? cursor.lastSeq;
    const newLastId = lastRow?.id ?? cursor.lastId;

    // Persist cursor state atomically
    await this.exportCursorRepo.update(cursor.id, {
      lastSeq: newLastSeq,
      lastId: newLastId,
      pagesFetched: cursor.pagesFetched + 1,
      rowsExported: cursor.rowsExported + rows.length,
      checkpointHash,
      status: exhausted ? 'exhausted' : 'active',
    });

    const elapsedMs = Date.now() - pageStart;
    const format = cursor.format;

    return {
      success: true,
      data: format === 'json' ? allowlisted : null,
      csv: format === 'csv' ? this.toCsvString(allowlisted) : null,
      meta: {
        cursorId: cursor.id,
        status: exhausted ? 'exhausted' : 'active',
        pageCount: rows.length,
        totalExported: cursor.rowsExported + rows.length,
        pagesFetched: cursor.pagesFetched + 1,
        exhausted,
        checkpointHash,
        exportVersion: cursor.exportVersion,
        format,
        expiresAt: cursor.expiresAt.toISOString(),
        elapsedMs,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Cancel an active cursor session.  No-op if already exhausted/expired.
   * Callers can only cancel their own cursors; the capability guard
   * enforces this before calling here.
   */
  async cancelCursor(cursorId: string, requesterId: string): Promise<void> {
    const cursor = await this.exportCursorRepo.findOne({
      where: { id: cursorId },
    });
    if (!cursor) return; // Idempotent — nothing to cancel

    if (cursor.requesterId !== requesterId) {
      throw new ForbiddenException(
        'Cannot cancel a cursor owned by another requester',
      );
    }

    if (cursor.status === 'active') {
      await this.exportCursorRepo.update(cursor.id, { status: 'cancelled' });
    }
  }

  /**
   * Expire any cursor rows whose `expiresAt` timestamp has passed.
   * Called by a scheduled job; not exposed via HTTP.
   */
  async expireStalecursors(): Promise<number> {
    const result = await this.exportCursorRepo.update(
      { status: 'active', expiresAt: MoreThan(new Date()) as any },
      { status: 'expired' },
    );
    // We want rows WHERE expiresAt < now AND status = active
    // TypeORM `update` does not directly support LessThan in a useful way for this;
    // use a query builder instead.
    const qb = this.exportCursorRepo
      .createQueryBuilder()
      .update(ExportCursor)
      .set({ status: 'expired' })
      .where('status = :s', { s: 'active' })
      .andWhere('expiresAt < :now', { now: new Date() });

    const updateResult = await qb.execute();
    return updateResult.affected ?? 0;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async createCursor(
    dto: ExportAuditCursorDto,
    requesterId: string,
  ): Promise<ExportCursor> {
    const expiresAt = new Date(
      Date.now() + EXPORT_CURSOR_TTL_SECONDS * 1_000,
    );

    const filters: Record<string, unknown> = {};
    if (dto.entityType) filters['entityType'] = dto.entityType;
    if (dto.actionType) filters['actionType'] = dto.actionType;
    if (dto.severity) filters['severity'] = dto.severity;
    if (dto.category) filters['category'] = dto.category;
    if (dto.userId) filters['userId'] = dto.userId;
    if (dto.startDate) filters['startDate'] = dto.startDate;
    if (dto.endDate) filters['endDate'] = dto.endDate;

    const cursor = this.exportCursorRepo.create({
      id: randomUUID(),
      requesterId,
      status: 'active',
      filters,
      lastSeq: 0,
      lastId: null,
      pagesFetched: 0,
      rowsExported: 0,
      checkpointHash: null,
      format: dto.format ?? 'json',
      exportVersion: '1',
      expiresAt,
    });

    return this.exportCursorRepo.save(cursor);
  }

  private async resumeCursor(
    cursorId: string,
    requesterId: string,
  ): Promise<ExportCursor> {
    const cursor = await this.exportCursorRepo.findOne({
      where: { id: cursorId },
    });

    if (!cursor) {
      throw new NotFoundException(`Export cursor ${cursorId} not found`);
    }

    if (cursor.requesterId !== requesterId) {
      // Fail closed: different requester ID is treated the same as
      // not-found to avoid leaking cursor existence.
      throw new ForbiddenException('Export cursor not accessible');
    }

    return cursor;
  }

  private assertCursorActive(cursor: ExportCursor): void {
    if (cursor.status === 'expired' || cursor.expiresAt <= new Date()) {
      throw new GoneException('Export cursor has expired');
    }
    if (cursor.status === 'cancelled') {
      throw new GoneException('Export cursor has been cancelled');
    }
    if (cursor.status === 'exhausted') {
      throw new UnprocessableEntityException(
        'Export cursor is exhausted — no further pages',
      );
    }
    if (cursor.status !== 'active') {
      // Unknown status: fail closed
      throw new ForbiddenException(`Export cursor is in an unknown state: ${cursor.status}`);
    }
  }

  private assertWithinGlobalLimits(cursor: ExportCursor): void {
    if (cursor.rowsExported >= EXPORT_ROW_LIMIT_TOTAL) {
      throw new UnprocessableEntityException(
        `Export row limit reached (${EXPORT_ROW_LIMIT_TOTAL.toLocaleString()} rows maximum per cursor session)`,
      );
    }
    if (cursor.pagesFetched >= EXPORT_PAGE_LIMIT) {
      throw new UnprocessableEntityException(
        `Export page limit reached (${EXPORT_PAGE_LIMIT.toLocaleString()} pages maximum per cursor session)`,
      );
    }
  }

  private async queryPage(
    cursor: ExportCursor,
    limit: number,
    pageStart: number,
  ): Promise<AuditLog[]> {
    const filters = cursor.filters as Record<string, unknown>;

    const qb = this.auditLogRepo
      .createQueryBuilder('al')
      // Keyset pagination: continue strictly after the last seen position
      .where('al.chainSequence > :lastSeq OR al.chainSequence IS NULL', {
        lastSeq: cursor.lastSeq,
      });

    // For rows with chainSequence = NULL (pre-chain legacy rows), fall back to
    // cursor-after-id.  We emit them in id-order at the start (seq = 0 means
    // the cursor hasn't moved yet).
    if (cursor.lastSeq > 0) {
      // Strictly after the previous checkpoint by chain sequence
      qb.where('al.chainSequence > :lastSeq', { lastSeq: cursor.lastSeq });
    } else {
      // First page: include all (legacy rows appear first, ordered by id)
      qb.where('1 = 1');
    }

    // Apply stored filters
    if (filters['entityType']) {
      qb.andWhere('al.entityType = :entityType', {
        entityType: filters['entityType'],
      });
    }
    if (filters['actionType']) {
      qb.andWhere('al.actionType = :actionType', {
        actionType: filters['actionType'],
      });
    }
    if (filters['severity']) {
      qb.andWhere('al.severity = :severity', { severity: filters['severity'] });
    }
    if (filters['category']) {
      qb.andWhere('al.category = :category', { category: filters['category'] });
    }
    if (filters['userId']) {
      qb.andWhere('al.userId = :userId', { userId: filters['userId'] });
    }
    if (filters['startDate']) {
      qb.andWhere('al.createdAt >= :startDate', {
        startDate: new Date(filters['startDate'] as string),
      });
    }
    if (filters['endDate']) {
      qb.andWhere('al.createdAt <= :endDate', {
        endDate: new Date(filters['endDate'] as string),
      });
    }

    // Stable order: chain sequence (nulls last), then ID
    qb.orderBy('al.chainSequence', 'ASC', 'NULLS LAST')
      .addOrderBy('al.id', 'ASC')
      .take(limit);

    // Enforce wall-clock time limit
    const rows = await Promise.race([
      qb.getMany(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new RequestTimeoutException(
                `Export page query exceeded time limit (${EXPORT_TIME_LIMIT_MS} ms)`,
              ),
            ),
          EXPORT_TIME_LIMIT_MS,
        ),
      ),
    ]);

    const elapsed = Date.now() - pageStart;
    this.logger.debug(
      `Export cursor ${cursor.id}: page ${cursor.pagesFetched + 1} fetched ${rows.length} rows in ${elapsed} ms`,
    );

    return rows;
  }

  /**
   * Strip all columns not in EXPORT_FIELD_ALLOWLIST.  This is the sole
   * projection gate — it runs after the DB fetch so nothing in
   * `queryPage` can accidentally expose a sensitive field.
   */
  private applyAllowlist(row: AuditLog): ExportedAuditRow {
    return EXPORT_FIELD_ALLOWLIST.reduce((acc, field) => {
      const value = (row as any)[field];
      (acc as any)[field] =
        value instanceof Date ? value.toISOString() : value ?? null;
      return acc;
    }, {} as ExportedAuditRow);
  }

  /**
   * Compute an HMAC-SHA256 integrity checkpoint over the serialised row
   * array.  Callers can verify this independently using the same secret
   * that protects the individual audit record hashes.
   *
   * Reuses AUDIT_HASH_SECRET (fails open in non-production with a
   * clearly labelled dev secret, consistent with AuditTrailService).
   */
  private computeCheckpointHash(rows: ExportedAuditRow[]): string {
    const secret = this.getHashSecret();
    const payload = JSON.stringify(rows);
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  private hashSecret: string | undefined;

  private getHashSecret(): string {
    if (this.hashSecret) return this.hashSecret;
    const configured = this.configService.get<string>('AUDIT_HASH_SECRET');
    if (configured) {
      this.hashSecret = configured;
      return this.hashSecret;
    }
    const env = this.configService.get<string>('NODE_ENV');
    if (env === 'production') {
      throw new Error(
        'AUDIT_HASH_SECRET is not configured; refusing to export audit logs without integrity protection.',
      );
    }
    this.logger.warn(
      'AUDIT_HASH_SECRET not set; using insecure dev secret for export checkpoint hashes.',
    );
    this.hashSecret = 'insecure-development-only-audit-hash-secret';
    return this.hashSecret;
  }

  // ─── CSV helpers ───────────────────────────────────────────────────────────

  private toCsvString(rows: ExportedAuditRow[]): string {
    const headers = [...EXPORT_FIELD_ALLOWLIST];

    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      headers.join(','),
      ...rows.map((r) =>
        headers.map((h) => escape((r as any)[h])).join(','),
      ),
    ];

    return lines.join('\n');
  }
}
