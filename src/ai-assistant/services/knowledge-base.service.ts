import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContextDocument } from '../entities/context-document.entity';
import { CreateContextDocumentDto } from '../dto/create-context-document.dto';
import { UpdateContextDocumentDto } from '../dto/update-context-document.dto';
import { ContextDocumentQueryDto } from '../dto/context-document-query.dto';
import { AiAssistantCache } from '../cache/ai-assistant.cache';

/** CRUD surface for the ContextDocument corpus that ContextRetrievalService searches over. */
@Injectable()
export class KnowledgeBaseService {
  constructor(
    @InjectRepository(ContextDocument)
    private readonly contextDocumentRepository: Repository<ContextDocument>,
    private readonly cache: AiAssistantCache,
  ) {}

  async create(
    createdBy: string,
    dto: CreateContextDocumentDto,
  ): Promise<ContextDocument> {
    const document = this.contextDocumentRepository.create({
      ...dto,
      createdBy,
    });
    const saved = await this.contextDocumentRepository.save(document);
    await this.cache.invalidateAllContextResults();
    return saved;
  }

  async list(
    query: ContextDocumentQueryDto,
  ): Promise<{ items: ContextDocument[]; total: number }> {
    const [items, total] = await this.contextDocumentRepository.findAndCount({
      where: {
        ...(query.category ? { category: query.category } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      },
      order: { createdAt: 'DESC' },
      take: query.limit ?? 20,
      skip: query.offset ?? 0,
    });
    return { items, total };
  }

  async findOne(id: string): Promise<ContextDocument> {
    const document = await this.contextDocumentRepository.findOne({
      where: { id },
    });
    if (!document) {
      throw new NotFoundException('Context document not found');
    }
    return document;
  }

  async update(
    id: string,
    dto: UpdateContextDocumentDto,
  ): Promise<ContextDocument> {
    const document = await this.findOne(id);
    Object.assign(document, dto);
    const saved = await this.contextDocumentRepository.save(document);
    await this.cache.invalidateAllContextResults();
    return saved;
  }

  async remove(id: string): Promise<void> {
    const document = await this.findOne(id);
    document.isActive = false;
    await this.contextDocumentRepository.save(document);
    await this.cache.invalidateAllContextResults();
  }
}
