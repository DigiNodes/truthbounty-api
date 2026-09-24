import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Conversation } from './conversation.entity';

export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
}

export interface MessageCitation {
  documentId: string;
  title: string;
  score: number;
  sourceUrl?: string;
}

@Entity('ai_messages')
@Index(['conversationId', 'createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  conversationId: string;

  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'varchar' })
  role: MessageRole;

  @Column('text')
  content: string;

  @Column({ type: 'int', nullable: true })
  promptTokens: number;

  @Column({ type: 'int', nullable: true })
  completionTokens: number;

  @Column({ type: 'int', nullable: true })
  totalTokens: number;

  @Column('simple-json', { nullable: true })
  citations: MessageCitation[] | null;

  @Column({ nullable: true })
  provider: string;

  @Column({ nullable: true })
  model: string;

  @Column({ type: 'int', nullable: true })
  latencyMs: number;

  @Column({ type: 'boolean', default: false })
  flagged: boolean;

  @Column({ nullable: true })
  flagReason: string;

  @Column({ type: 'boolean', default: false })
  redacted: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
