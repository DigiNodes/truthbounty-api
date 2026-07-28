import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { NotificationChannel } from '../enums/notification-channel.enum';
import { NotificationCategory } from '../enums/notification-category.enum';
import { NotificationStatus } from '../enums/notification-status.enum';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  userId: string;

  @Column({ type: 'varchar' })
  category: NotificationCategory;

  @Column({ type: 'varchar' })
  channel: NotificationChannel;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'varchar', default: NotificationStatus.QUEUED })
  status: NotificationStatus;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'varchar', nullable: true })
  errorMessage: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
