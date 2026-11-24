import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Locked before appending, in the same transaction as the audit record. */
@Entity('admin_audit_head')
export class AdminAuditHead {
  @PrimaryColumn({ type: 'smallint' })
  id: number;

  @Column({ type: 'bigint', default: '0' })
  lastSequence: string;

  @Column({ type: 'varchar', nullable: true })
  lastHash: string | null;
}
