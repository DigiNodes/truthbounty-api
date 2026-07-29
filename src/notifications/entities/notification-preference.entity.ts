import { Entity, Column, PrimaryGeneratedColumn, OneToOne, JoinColumn } from 'typeorm';
import { User } from '../../entities/user.entity';
import { UserPreferenceSettings } from '../interfaces/notification.types';

@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn()
  user: User;

  @Column({ type: 'jsonb' })
  settings: UserPreferenceSettings;

  @Column({ default: () => 'now()' })
  createdAt: Date;

  @Column({ default: () => 'now()' })
  updatedAt: Date;
}