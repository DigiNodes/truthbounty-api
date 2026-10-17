import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToOne,
  JoinColumn,
  AfterLoad,
} from 'typeorm';
import { User } from '../../entities/user.entity';
import { NotificationFrequency } from '../enums/notification-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';
import { parseDeliveryChannel } from '../delivery/delivery-channel';

@Entity('user_notification_preferences')
@Index(['userId'])
export class UserNotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'simple-array', default: 'in_app' })
  enabledChannels: string[];

  @AfterLoad()
  normalizeChannels(): void {
    if (this.enabledChannels && Array.isArray(this.enabledChannels)) {
      this.enabledChannels = this.enabledChannels
        .map((ch) => parseDeliveryChannel(ch))
        .filter((ch): ch is DeliveryChannel => ch !== null);
    }
  }

  @Column({
    type: 'varchar',
    enum: NotificationFrequency,
    default: NotificationFrequency.INSTANT,
  })
  frequency: NotificationFrequency;

  @Column({ type: 'simple-array', nullable: true })
  quietHoursStart: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  quietHoursEnd: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  subscribedCategories: string[];

  @Column({ type: 'simple-array', nullable: true })
  unsubscribedCategories: string[];

  @Column({ default: false })
  digestEnabled: boolean;

  @Column({ type: 'varchar', enum: NotificationFrequency, nullable: true })
  digestFrequency: NotificationFrequency;

  @Column({ nullable: true })
  emailAddress: string;

  @Column({ nullable: true })
  webhookUrl: string;

  @Column({ nullable: true })
  pushToken: string;

  @Column({ type: 'simple-array', nullable: true })
  pushPlatforms: string[];

  @Column({ default: true })
  notificationsEnabled: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
