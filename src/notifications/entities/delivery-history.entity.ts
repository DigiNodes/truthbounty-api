import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, CreateDateColumn } from 'typeorm';
import { Notification } from './notification.entity';
import { DeliveryChannel, DeliveryStatus } from '../interfaces/notification.types';

@Entity('delivery_history')
export class DeliveryHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  notificationId: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  notification: Notification;

  @Column({
    type: 'varchar',
    length: 20,
  })
  channel: DeliveryChannel;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'pending',
  })
  status: DeliveryStatus;

  @Column({ type: 'int', default: 0 })
  retryAttempts: number;

  @Column({ nullable: true })
  lastRetryAt: Date;

  @Column({ nullable: true })
  deliveredAt: Date;

  @Column({ nullable: true })
  failureReason: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}