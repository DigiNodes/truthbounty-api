import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);
  private openai: OpenAI | null = null;
  private anthropic: Anthropic | null = null;
  private defaultProvider: 'openai' | 'anthropic';

  constructor(private configService: ConfigService) {
    const openaiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
    }

    const anthropicKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (anthropicKey) {
      this.anthropic = new Anthropic({ apiKey: anthropicKey });
    }

    this.defaultProvider = this.configService.get<'openai' | 'anthropic'>('DEFAULT_LLM_PROVIDER') || 'openai';
  }

  async generateResponse(
    messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
    options?: { provider?: 'openai' | 'anthropic' }
  ): Promise<{ content: string; usage: any; provider: string; model: string }> {
    const provider = options?.provider || this.defaultProvider;

    if (provider === 'openai' && this.openai) {
      const model = 'gpt-4o-mini';
      const response = await this.openai.chat.completions.create({
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });
      return {
        content: response.choices[0].message.content || '',
        usage: response.usage,
        provider: 'openai',
        model,
      };
    } else if (provider === 'anthropic' && this.anthropic) {
      const model = 'claude-3-haiku-20240307';
      const systemMessage = messages.find(m => m.role === 'system')?.content;
      const otherMessages = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: m.content
      }));

      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: systemMessage,
        messages: otherMessages,
      });
      
      const content = response.content[0].type === 'text' ? response.content[0].text : '';
      return {
        content,
        usage: {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        provider: 'anthropic',
        model,
      };
    }

    // Mock fallback if keys not configured
    this.logger.warn(`No valid LLM provider configured for ${provider}, using mock response.`);
    return {
      content: `This is a mock response from the AI Assistant because the API keys for ${provider} are not configured. You said: ${messages[messages.length - 1]?.content}`,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      provider: 'mock',
      model: 'mock-model',
    };
  }
}
