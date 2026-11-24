import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type ExportCursorStatus = 'active' | 'cancelled' | 'exhausted' | 'expired';

/**
 * Persisted state for a single cursor-based audit export session
 * (PREWAVE-BE-033).
 *
 * A cursor row is created when an authorised caller issues the first
 * page request.  Subsequent page requests look up the same cursor by
 * `id`.  The row is updated after each page (progress counters,
 * `lastSeq`, `checkpointHash`).  The capability guard rejects requests
 * against cursors that are not in `active` status.
 *
 * This row is NOT part of the audit hash chain; it is a mutable working
 * document.
 */
@Entity('export_cursors')
@Index(['requesterId', 'status'])
@Index(['expiresAt'])
export class ExportCursor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** ID of the admin user who initiated the export. */
  @Column({ type: 'varchar' })
  requesterId: string;

  /** Lifecycle state. The capability guard fails closed on any non-active value. */
  @Column({ type: 'varchar', default: 'active' })
  status: ExportCursorStatus;

  /**
   * Serialised filter set used to initialise this export session.
   * Stored so that page 2…n use exactly the same predicate as page 1,
   * even if the caller were to mutate query parameters between requests
   * (which is rejected by the guard anyway, but defence-in-depth).
   */
  @Column({ type: 'simple-json', default: '{}' })
  filters: Record<string, unknown>;

  /**
   * `chainSequence` of the last audit log row returned in the previous
   * page.  The next page starts immediately after this value.
   * `0` = no rows returned yet (cursor just initialised).
   */
  @Column({ type: 'bigint', default: 0, transformer: {
    to: (v: number) => v,
    from: (v: string | number | null) => (v == null ? 0 : Number(v)),
  }})
  lastSeq: number;

  /** UUID of the last audit log row returned (tie-breaker). */
  @Column({ type: 'varchar', nullable: true })
  lastId: string | null;

  /** How many pages have been fetched so far. */
  @Column({ type: 'integer', default: 0 })
  pagesFetched: number;

  /** Total audit rows exported across all pages. */
  @Column({ type: 'bigint', default: 0, transformer: {
    to: (v: number) => v,
    from: (v: string | number | null) => (v == null ? 0 : Number(v)),
  }})
  rowsExported: number;

  /**
   * HMAC-SHA256 of the JSON-serialised rows in the most-recently
   * returned page.  Callers can verify this to confirm a page has
   * not been altered in transit.  Null until the first page is fetched.
   */
  @Column({ type: 'varchar', nullable: true })
  checkpointHash: string | null;

  /** Output format for this session: 'json' (default) or 'csv'. */
  @Column({ type: 'varchar', default: 'json' })
  format: 'json' | 'csv';

  /** Export format/schema version (currently always '1'). */
  @Column({ type: 'varchar', default: '1' })
  exportVersion: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /** Hard expiry time. The guard refuses any request after this timestamp. */
  @Column({ type: 'datetime' })
  expiresAt: Date;
}
