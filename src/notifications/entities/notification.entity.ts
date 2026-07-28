import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from '../../entities/user.entity';
import {
  NotificationType,
  DeliveryChannel,
  NotificationPriority,
} from '../enums/notification-type.enum';
import { NotificationDelivery } from './notification-delivery.entity';

@Entity('notifications')
@Index(['userId', 'createdAt'])
@Index(['userId', 'readAt'])
@Index(['type'])
@Index(['status'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  walletAddress: string;

  @Column({ type: 'varchar', enum: NotificationType })
  type: NotificationType;

  @Column()
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'json', nullable: true })
  data: Record<string, any>;

  @Column({ type: 'varchar', enum: NotificationPriority, default: NotificationPriority.NORMAL })
  priority: NotificationPriority;

  @Column({ default: false })
  read: boolean;

  @Column({ type: 'datetime', nullable: true })
  readAt: Date;

  @Column({ type: 'varchar', default: 'PENDING' })
  status: string;

  @Column({ type: 'datetime', nullable: true })
  scheduledAt: Date;

  @Column({ type: 'datetime', nullable: true })
  sentAt: Date;

  @OneToMany(() => NotificationDelivery, (delivery) => delivery.notification, { cascade: true })
  deliveries: NotificationDelivery[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
