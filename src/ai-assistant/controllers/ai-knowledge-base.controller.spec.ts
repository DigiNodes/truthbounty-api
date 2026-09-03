import { AiKnowledgeBaseController } from './ai-knowledge-base.controller';
import { ContextDocumentCategory } from '../entities/context-document.entity';

describe('AiKnowledgeBaseController', () => {
  let controller: AiKnowledgeBaseController;
  let knowledgeBaseService: any;

  const admin = {
    userId: 'admin-1',
    address: '0xabc',
    user: { id: 'admin-1', role: 'admin' as const },
  };

  beforeEach(() => {
    knowledgeBaseService = {
      create: jest.fn(),
      list: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    controller = new AiKnowledgeBaseController(knowledgeBaseService);
  });

  it('list() wraps items/total with pagination meta', async () => {
    knowledgeBaseService.list.mockResolvedValue({
      items: [{ id: 'doc-1' }],
      total: 1,
    });
    const result = await controller.list({ limit: 20, offset: 0 } as any);
    expect(result).toEqual({
      data: { items: [{ id: 'doc-1' }], total: 1 },
      meta: { limit: 20, offset: 0 },
    });
  });

  it('create() passes the requesting user id as createdBy', async () => {
    const dto = {
      title: 'Staking',
      category: ContextDocumentCategory.PROTOCOL_DOCS,
      content: 'text',
    };
    knowledgeBaseService.create.mockResolvedValue({
      id: 'doc-1',
      ...dto,
      createdBy: 'admin-1',
    });

    const result = await controller.create(admin, dto as any);

    expect(knowledgeBaseService.create).toHaveBeenCalledWith('admin-1', dto);
    expect(result.createdBy).toBe('admin-1');
  });

  it('update() and remove() delegate to the service', async () => {
    await controller.update('doc-1', { title: 'New title' } as any);
    expect(knowledgeBaseService.update).toHaveBeenCalledWith('doc-1', {
      title: 'New title',
    });

    await controller.remove('doc-1');
    expect(knowledgeBaseService.remove).toHaveBeenCalledWith('doc-1');
  });
});
