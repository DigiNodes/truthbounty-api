import { NotFoundException } from '@nestjs/common';
import { KnowledgeBaseService } from './knowledge-base.service';
import { ContextDocumentCategory } from '../entities/context-document.entity';

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;
  let repository: any;
  let cache: { invalidateAllContextResults: jest.Mock };

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation((entry) => entry),
      save: jest
        .fn()
        .mockImplementation(async (entry) => ({ id: 'doc-1', ...entry })),
      findAndCount: jest.fn(),
      findOne: jest.fn(),
    };
    cache = { invalidateAllContextResults: jest.fn() };
    service = new KnowledgeBaseService(repository, cache as any);
  });

  it('creates a document and invalidates the context cache', async () => {
    const doc = await service.create('admin-1', {
      title: 'Staking',
      category: ContextDocumentCategory.PROTOCOL_DOCS,
      content: 'text',
    });

    expect(doc.createdBy).toBe('admin-1');
    expect(cache.invalidateAllContextResults).toHaveBeenCalled();
  });

  it('throws NotFoundException when updating a missing document', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(
      service.update('missing', { title: 'x' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('soft-deletes by setting isActive to false', async () => {
    repository.findOne.mockResolvedValue({ id: 'doc-1', isActive: true });
    await service.remove('doc-1');

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
    );
    expect(cache.invalidateAllContextResults).toHaveBeenCalled();
  });
});
