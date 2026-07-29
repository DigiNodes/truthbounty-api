import { firstValueFrom, of, throwError, toArray } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { AiStreamController } from './ai-stream.controller';
import { AiUsageStatus } from '../entities/ai-usage-log.entity';

describe('AiStreamController', () => {
  let controller: AiStreamController;
  let conversationService: any;
  let promptOrchestrationService: any;
  let safetyGuardrailService: any;
  let cache: any;
  let metrics: any;

  const currentUser = {
    userId: 'user-1',
    address: '0xabc',
    user: { id: 'user-1', role: 'contributor' as const },
  };
  const conversation = { id: 'conv-1', userId: 'user-1' };

  beforeEach(() => {
    conversationService = {
      findOwned: jest.fn().mockResolvedValue(conversation),
      finalizeAssistantMessage: jest
        .fn()
        .mockResolvedValue({ id: 'msg-assistant-1', content: 'Hi there' }),
    };
    promptOrchestrationService = { prepareStream: jest.fn() };
    safetyGuardrailService = {
      containsCanaryLeak: jest.fn().mockReturnValue(false),
      LEAK_REFUSAL_MESSAGE: 'nope',
    };
    cache = {
      getStreamPending: jest.fn().mockResolvedValue({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        userId: 'user-1',
        content: 'hi',
      }),
      clearStreamPending: jest.fn(),
    };
    metrics = {
      recordRequest: jest.fn(),
      observeLatency: jest.fn(),
      recordTokens: jest.fn(),
    };
    const configService = {
      get: jest.fn().mockReturnValue({ openai: { model: 'gpt-4o-mini' } }),
    } as unknown as ConfigService;

    controller = new AiStreamController(
      conversationService,
      promptOrchestrationService,
      safetyGuardrailService,
      cache,
      metrics,
      configService,
    );
  });

  it('emits citation, then chunk events, then a terminal done event, and persists the assistant message once', async () => {
    promptOrchestrationService.prepareStream.mockResolvedValue({
      blocked: false,
      citations: [{ documentId: 'doc-1', title: 'Staking', score: 1 }],
      canaryToken: 'cnry_x',
      providerName: 'mock',
      fallback: false,
      stream: of(
        { delta: 'Hi ', done: false },
        {
          delta: 'there',
          done: true,
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        },
      ),
    });

    const events = await firstValueFrom(
      controller.stream(currentUser, 'conv-1', 'msg-1').pipe(toArray()),
    );

    expect(events.map((e) => e.type)).toEqual([
      'citation',
      'chunk',
      'chunk',
      'done',
    ]);
    expect((events[0].data as any).citations).toHaveLength(1);
    expect(events[1].data as any).toEqual({ delta: 'Hi ', index: 0 });
    expect(events[2].data as any).toEqual({ delta: 'there', index: 1 });
    expect((events[3].data as any).message.content).toBe('Hi there');

    expect(conversationService.finalizeAssistantMessage).toHaveBeenCalledTimes(
      1,
    );
    expect(conversationService.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: AiUsageStatus.SUCCESS,
        promptTokens: 5,
        completionTokens: 3,
        totalTokens: 8,
      }),
    );
    expect(cache.clearStreamPending).toHaveBeenCalledWith('msg-1');
  });

  it('emits a single done event for a safety-blocked message, without ever subscribing to a provider stream', async () => {
    promptOrchestrationService.prepareStream.mockResolvedValue({
      blocked: true,
      refusalContent: "I can't help with that.",
      flagReason: 'blocklist_match',
    });

    const events = await firstValueFrom(
      controller.stream(currentUser, 'conv-1', 'msg-1').pipe(toArray()),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
    expect(conversationService.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: AiUsageStatus.SAFETY_BLOCKED }),
    );
  });

  it('emits an error event and logs usage as an error when the provider stream fails', async () => {
    promptOrchestrationService.prepareStream.mockResolvedValue({
      blocked: false,
      citations: [],
      canaryToken: 'cnry_x',
      providerName: 'mock',
      fallback: false,
      stream: throwError(() => new Error('provider down')),
    });

    const events = await firstValueFrom(
      controller.stream(currentUser, 'conv-1', 'msg-1').pipe(toArray()),
    );

    expect(events.map((e) => e.type)).toEqual(['citation', 'error']);
    expect(conversationService.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: AiUsageStatus.ERROR }),
    );
    expect(cache.clearStreamPending).toHaveBeenCalledWith('msg-1');
  });

  it('emits a NOT_FOUND error when there is no pending marker for the message', async () => {
    cache.getStreamPending.mockResolvedValue(null);

    const events = await firstValueFrom(
      controller.stream(currentUser, 'conv-1', 'missing-msg').pipe(toArray()),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0].data as any).code).toBe('NOT_FOUND');
  });

  it('replaces leaked content with a refusal and flags the message', async () => {
    safetyGuardrailService.containsCanaryLeak.mockReturnValue(true);
    promptOrchestrationService.prepareStream.mockResolvedValue({
      blocked: false,
      citations: [],
      canaryToken: 'cnry_x',
      providerName: 'mock',
      fallback: false,
      stream: of({ delta: 'cnry_x leaked', done: true }),
    });

    await firstValueFrom(
      controller.stream(currentUser, 'conv-1', 'msg-1').pipe(toArray()),
    );

    expect(conversationService.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'nope',
        flagged: true,
        flagReason: 'prompt_leak_detected',
      }),
    );
  });
});
