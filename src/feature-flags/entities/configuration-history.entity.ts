import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('configuration_history')
@Index(['configurationId', 'version'], { unique: true })
export class ConfigurationHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  configurationId: string;

  @Column()
  key: string;

  @Column({ type: 'json' })
  value: unknown;

  @Column()
  environment: string;

  @Column()
  version: number;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ type: 'text', nullable: true })
  changeReason: string;

  @CreateDateColumn()
  createdAt: Date;
}
