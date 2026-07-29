import { AiConversationsController } from './ai-conversations.controller';
import { ConversationMode } from '../entities/conversation.entity';

describe('AiConversationsController', () => {
  let controller: AiConversationsController;
  let conversationService: any;
  let cache: any;

  const currentUser = {
    userId: 'user-1',
    address: '0xabc',
    user: { id: 'user-1', role: 'contributor' as const },
  };

  beforeEach(() => {
    conversationService = {
      create: jest.fn(),
      list: jest.fn(),
      findOwned: jest.fn(),
      listMessages: jest.fn(),
      archive: jest.fn(),
      remove: jest.fn(),
      sendMessage: jest.fn(),
      stageStreamMessage: jest.fn(),
    };
    cache = { setStreamPending: jest.fn() };
    controller = new AiConversationsController(conversationService, cache);
  });

  it('create() delegates to the service with the resolved role', async () => {
    conversationService.create.mockResolvedValue({ id: 'conv-1' });
    const dto = { mode: ConversationMode.GENERAL };

    const result = await controller.create(currentUser, dto);

    expect(conversationService.create).toHaveBeenCalledWith(
      'user-1',
      'contributor',
      dto,
    );
    expect(result).toEqual({ id: 'conv-1' });
  });

  it('defaults the role to contributor when the Prisma user record is missing', async () => {
    conversationService.create.mockResolvedValue({ id: 'conv-1' });
    await controller.create(
      { userId: 'user-2', address: '0x1', user: null },
      {},
    );
    expect(conversationService.create).toHaveBeenCalledWith(
      'user-2',
      'contributor',
      {},
    );
  });

  it('list() wraps items/total with pagination meta', async () => {
    conversationService.list.mockResolvedValue({
      items: [{ id: 'c1' }],
      total: 1,
    });
    const result = await controller.list(currentUser, { limit: 10, offset: 0 });
    expect(result).toEqual({
      data: { items: [{ id: 'c1' }], total: 1 },
      meta: { limit: 10, offset: 0 },
    });
  });

  it('sendMessage() delegates and surfaces the fallback flag in meta', async () => {
    conversationService.sendMessage.mockResolvedValue({
      userMessage: {},
      assistantMessage: {},
      fallback: true,
    });

    const result = await controller.sendMessage(currentUser, 'conv-1', {
      content: 'hi',
    });

    expect(conversationService.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'contributor',
      'conv-1',
      {
        content: 'hi',
      },
    );
    expect(result.meta).toEqual({ fallback: true });
  });

  it('stageStreamMessage() persists the user message and caches a pending marker referencing its id', async () => {
    conversationService.stageStreamMessage.mockResolvedValue({ id: 'msg-1' });

    const result = await controller.stageStreamMessage(currentUser, 'conv-1', {
      content: 'hi',
    });

    expect(conversationService.stageStreamMessage).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
      'hi',
    );
    expect(cache.setStreamPending).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      userId: 'user-1',
      content: 'hi',
    });
    expect(result).toEqual({
      messageId: 'msg-1',
      streamUrl: '/ai-assistant/conversations/conv-1/stream/msg-1',
    });
  });

  it('remove() delegates to the service', async () => {
    await controller.remove(currentUser, 'conv-1');
    expect(conversationService.remove).toHaveBeenCalledWith('user-1', 'conv-1');
  });
});
