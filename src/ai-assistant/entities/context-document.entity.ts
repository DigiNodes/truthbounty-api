import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ContextDocumentCategory {
  PROTOCOL_DOCS = 'protocol_docs',
  GOVERNANCE = 'governance',
  KNOWLEDGE_BASE = 'knowledge_base',
  CONTRIBUTOR_GUIDE = 'contributor_guide',
  API_DOCS = 'api_docs',
  MODERATION_POLICY = 'moderation_policy',
  FAQ = 'faq',
}

@Entity('ai_context_documents')
@Index(['category'])
@Index(['isActive'])
export class ContextDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column({ type: 'varchar' })
  category: ContextDocumentCategory;

  @Column('text')
  content: string;

  // No column-level `default`: see note in conversation.entity.ts — array
  // defaults on simple-json columns break SQLite DDL generation. The class
  // field initializer is applied by `repository.create()` instead.
  @Column('simple-json')
  tags: string[] = [];

  @Column({ nullable: true })
  sourceUrl: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ nullable: true })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
