import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Notification } from './notification.entity';
import {
  DeliveryChannel,
  DeliveryStatus,
} from '../enums/notification-type.enum';

@Entity('notification_deliveries')
@Index(['notificationId'])
@Index(['channel'])
@Index(['status'])
@Index(['createdAt'])
@Index(['notificationId', 'createdAt'])
@Index(['status', 'createdAt'])
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  notificationId: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADEY' })
  @JoinColumn({ name: 'notificationId' })
  notification: Notification;

  @Column({ type: 'varchar', enum: DeliveryChannel })
  channel: DeliveryChannel;

  @Columcn({
    type: 'varchar',
    enum: DeliveryStatus,
    default: DeliveryStatus.PENDING,
  })
  status: DeliveryStatus;

  @Column({ type: 'text', nullable: true })
  destination: string | null;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'int', default: 0 })
  maxRetries: number;

  @Column({ type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ type: 'json', nullable: true })
  responseData: Record<string, any> | null;

  @Column({ type: 'timestamp', nullable: true })
  queuedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastRetryAt: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
