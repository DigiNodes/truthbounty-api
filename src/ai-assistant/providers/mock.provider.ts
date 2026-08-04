import { Injectable } from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { concatMap, delay } from 'rxjs';
import {
  AiChatRequest,
  AiChatResponse,
  AiProvider,
  AiStreamChunk,
} from './ai-provider.interface';

const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / 4));

/**
 * Deterministic, zero-network provider. Default in tests and outside
 * NODE_ENV=production so the app and its test suite never require a real
 * AI provider API key.
 */
@Injectable()
export class MockProvider implements AiProvider {
  readonly name = 'mock';

  private available = true;

  /** Test hook to simulate an outage and exercise AiProviderRouterService fallback. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  private buildReply(request: AiChatRequest): string {
    const lastUser = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';
    const truncated =
      content.length > 120 ? `${content.slice(0, 120)}...` : content;
    return `Mock assistant response. Echo of your message: "${truncated}"`;
  }

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    const promptTokens = request.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );
    const content = this.buildReply(request);
    const completionTokens = estimateTokens(content);

    return {
      content,
      model: request.model || 'mock-model',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      finishReason: 'stop',
    };
  }

  stream(request: AiChatRequest): Observable<AiStreamChunk> {
    const content = this.buildReply(request);
    const words = content.split(' ');
    const chunkSize = Math.max(1, Math.ceil(words.length / 5));
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(
        words.slice(i, i + chunkSize).join(' ') +
          (i + chunkSize < words.length ? ' ' : ''),
      );
    }

    const promptTokens = request.messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );
    const completionTokens = estimateTokens(content);

    return from(chunks).pipe(
      concatMap((chunk, index) =>
        of({
          delta: chunk,
          done: index === chunks.length - 1,
          finishReason: index === chunks.length - 1 ? 'stop' : undefined,
          usage:
            index === chunks.length - 1
              ? {
                  promptTokens,
                  completionTokens,
                  totalTokens: promptTokens + completionTokens,
                }
              : undefined,
        } as AiStreamChunk).pipe(delay(10)),
      ),
    );
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}
