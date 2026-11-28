import { Entity, PrimaryGeneratedColumn, Column, Index, Unique } from 'typeorm';

@Entity('audit_stream_checkpoints')
@Unique('uq_stream_checkpoint', ['streamId'])
@Index('idx_checkpoint_stream', ['streamId', 'sequence'])
export class AuditStreamCheckpointEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  streamId: string;

  @Column({ type: 'integer' })
  sequence: number;

  @Column()
  headHash: string;

  @Column()
  keyId: string;

  @Column({ type: 'datetime' })
  createdAt: Date;
}
