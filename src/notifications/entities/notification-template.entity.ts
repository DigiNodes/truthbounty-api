import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { NotificationType } from '../enums/notification-type.enum';

@Entity('notification_templates')
@Index(['name'])
@Index(['type'])
export class NotificationTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ type: 'varchar', enum: NotificationType })
  type: NotificationType;

  @Column({ type: 'text' })
  subjectTemplate: string;

  @Column({ type: 'text' })
  bodyTemplate: string;

  @Column({ type: 'text', nullable: true })
  htmlTemplate: string;

  @Column({ type: 'text', nullable: true })
  markdownTemplate: string;

  @Column({ type: 'simple-array', default: '' })
  variables: string[];

  @Column({ type: 'varchar', default: 'en' })
  locale: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
