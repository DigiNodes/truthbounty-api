import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Observable, from } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';
import { AiConfig } from '../config/ai.config';
import {
  AiChatRequest,
  AiChatResponse,
  AiProvider,
  AiStreamChunk,
} from './ai-provider.interface';

/**
 * Wraps the OpenAI SDK. Reads OPENAI_BASE_URL as well as OPENAI_API_KEY so
 * this also works unmodified against local OpenAI-compatible servers
 * (Ollama, vLLM, LM Studio, etc).
 */
@Injectable()
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(private readonly configService: ConfigService) {
    const aiConfig = this.configService.get<AiConfig>('ai');
    this.client = new OpenAI({
      apiKey: aiConfig?.openai.apiKey || 'unset',
      baseURL: aiConfig?.openai.baseUrl,
    });
    this.defaultModel = aiConfig?.openai.model || 'gpt-4o-mini';
  }

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    const model = request.model || this.defaultModel;
    const completion = await this.client.chat.completions.create({
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    });

    const choice = completion.choices[0];
    return {
      content: choice?.message?.content ?? '',
      model: completion.model,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
      finishReason: choice?.finish_reason ?? 'stop',
    };
  }

  stream(request: AiChatRequest): Observable<AiStreamChunk> {
    const model = request.model || this.defaultModel;

    const streamPromise = this.client.chat.completions.create({
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
    });

    // The SDK resolves a Promise to an AsyncIterable of chunks; flatten both
    // layers with mergeMap(chunk => from(asyncIterable)) into a single stream.
    return from(streamPromise).pipe(
      mergeMap((stream) => from(stream)),
      map((chunk) => {
        const choice = chunk.choices[0];
        const finishReason = choice?.finish_reason ?? undefined;
        const done = Boolean(finishReason);
        return {
          delta: choice?.delta?.content ?? '',
          done,
          finishReason: finishReason ?? undefined,
          usage: chunk.usage
            ? {
                promptTokens: chunk.usage.prompt_tokens,
                completionTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
              }
            : undefined,
        } satisfies AiStreamChunk;
      }),
    );
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch (error) {
      this.logger.warn(
        `OpenAI availability check failed: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
