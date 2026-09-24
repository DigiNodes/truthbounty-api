import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../entities/user.entity';
import { UserPreferenceSettings } from '../interfaces/notification.types';

@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  @Index()
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'simple-json', default: '["IN_APP", "EMAIL"]' })
  enabledChannels: string[];

  @Column({ type: 'simple-json', default: '[]' })
  disabledCategories: string[];

  @Column({ type: 'boolean', default: false })
  digestMode: boolean;

  @Column({ type: 'boolean', default: false })
  quietHoursEnabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  quietHoursStart?: string;

  @Column({ type: 'varchar', nullable: true })
  quietHoursEnd?: string;

  @Column({ type: 'varchar', default: 'en' })
  language: string;

  @Column({ type: 'jsonb', nullable: true })
  settings?: UserPreferenceSettings;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}