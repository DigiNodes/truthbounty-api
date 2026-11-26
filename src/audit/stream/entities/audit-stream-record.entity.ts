import { Entity, PrimaryGeneratedColumn, Column, Index, Unique } from 'typeorm';

@Entity('audit_stream_records')
@Unique('uq_stream_sequence', ['streamId', 'sequence'])
@Index('idx_stream_sequence', ['streamId', 'sequence'])
@Index('idx_stream_head', ['streamId', 'createdAt'])
export class AuditStreamRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  streamId: string;

  @Column({ type: 'integer' })
  sequence: number;

  @Column()
  previousHash: string;

  @Column()
  payloadHash: string;

  @Column()
  hmacSignature: string;

  @Column()
  keyId: string;

  @Column({ type: 'bigint' })
  timestamp: number;

  @Column({ type: 'datetime' })
  createdAt: Date;
}
