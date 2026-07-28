import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ConversationMode {
  GENERAL = 'general',
  MODERATION_ASSIST = 'moderation_assist',
  ADMIN_ANALYTICS = 'admin_analytics',
}

export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

@Entity('conversations')
@Index(['userId', 'status'])
@Index(['userId', 'createdAt'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ nullable: true })
  title: string;

  @Column({ type: 'varchar', default: ConversationMode.GENERAL })
  mode: ConversationMode;

  @Column({ type: 'varchar', default: ConversationStatus.ACTIVE })
  status: ConversationStatus;

  @Column({ nullable: true })
  lastProvider: string;

  @Column({ type: 'int', default: 0 })
  totalTokens: number;

  // No column-level `default` here: TypeORM's simple-json object/array
  // defaults produce invalid SQLite DDL (`DEFAULT ()`). The class field
  // initializer below is applied by `repository.create()` instead.
  @Column('simple-json')
  metadata: Record<string, unknown> = {};

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
