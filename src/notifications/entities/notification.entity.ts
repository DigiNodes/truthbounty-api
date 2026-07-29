import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../entities/user.entity';
import { NotificationCategory, NotificationPriority } from '../interfaces/notification.types';

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user: User;

  @Column()
  title: string;

  @Column('text')
  message: string;

  @Column({
    type: 'varchar',
    length: 50,
  })
  category: NotificationCategory;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'medium',
  })
  priority: NotificationPriority;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  sourceEvent: Record<string, any>;

  @Column({ default: false })
  read: boolean;

  @Column({ nullable: true })
  readAt: Date;

  @Column({ nullable: true })
  scheduledFor: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}