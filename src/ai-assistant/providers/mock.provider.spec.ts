import { firstValueFrom, toArray } from 'rxjs';
import { MockProvider } from './mock.provider';
import { AiChatRequest } from './ai-provider.interface';

describe('MockProvider', () => {
  let provider: MockProvider;

  const request: AiChatRequest = {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'How does staking work?' },
    ],
    userId: 'user-1',
    requestId: 'req-1',
  };

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('returns a deterministic canned response echoing the last user message', async () => {
    const response = await provider.chat(request);
    expect(response.content).toContain('How does staking work?');
    expect(response.totalTokens).toBe(
      response.promptTokens + response.completionTokens,
    );
    expect(response.finishReason).toBe('stop');
  });

  it('is available by default', async () => {
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('can be forced unavailable to exercise fallback paths', async () => {
    provider.setAvailable(false);
    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('streams multiple chunks that concatenate to the same content as chat()', async () => {
    const chatResponse = await provider.chat(request);
    const chunks = await firstValueFrom(
      provider.stream(request).pipe(toArray()),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1].done).toBe(true);
    expect(chunks.slice(0, -1).every((c) => c.done === false)).toBe(true);

    const concatenated = chunks.map((c) => c.delta).join('');
    expect(concatenated.trim()).toBe(chatResponse.content.trim());
  });
});
