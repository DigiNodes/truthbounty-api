import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('configuration_values')
@Index(['key', 'environment'], { unique: true })
export class ConfigurationValue {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  key: string;

  @Column({ type: 'json' })
  value: unknown;

  @Column({ default: 'development' })
  environment: string;

  @Column({ default: 1 })
  version: number;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ type: 'text', nullable: true })
  changeReason: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
