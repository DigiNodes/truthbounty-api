import { Observable } from 'rxjs';

export type AiRole = 'system' | 'user' | 'assistant';

export interface AiChatMessage {
  role: AiRole;
  content: string;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  userId: string;
  requestId: string;
}

export interface AiChatResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finishReason: string;
}

export interface AiStreamChunk {
  delta: string;
  done: boolean;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Provider-agnostic contract for AI backends. AiProviderRouterService is the
 * sole consumer of implementations of this interface (OpenAiProvider,
 * MockProvider) — nothing else in the module talks to a provider directly.
 */
export interface AiProvider {
  readonly name: string;
  chat(request: AiChatRequest): Promise<AiChatResponse>;
  stream(request: AiChatRequest): Observable<AiStreamChunk>;
  isAvailable(): Promise<boolean>;
}

export const AI_PROVIDER_TOKENS = {
  OPENAI: 'AI_PROVIDER_OPENAI',
  MOCK: 'AI_PROVIDER_MOCK',
} as const;
