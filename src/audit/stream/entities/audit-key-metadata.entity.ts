import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('audit_key_metadata')
@Index('idx_key_active', ['isActive'])
@Index('idx_key_created', ['createdAt'])
export class AuditKeyMetadataEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  keyId: string;

  @Column()
  algorithm: string;

  @Column({ type: 'datetime' })
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
