import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  @Index()
  userId: string;

  @Column({ type: 'simple-json', default: '["IN_APP", "EMAIL"]' })
  enabledChannels: string[];

  @Column({ type: 'simple-json', default: '[]' })
  disabledCategories: string[];

  @Column({ type: 'boolean', default: false })
  digestMode: boolean;

  @Column({ type: 'boolean', default: false })
  quietHoursEnabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  quietHoursStart: string;

  @Column({ type: 'varchar', nullable: true })
  quietHoursEnd: string;

  @Column({ type: 'varchar', default: 'en' })
  language: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
