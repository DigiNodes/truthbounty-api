import {
  Controller,
  MessageEvent,
  NotFoundException,
  Param,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleByWallet } from '../../common/decorators/throttle-by-wallet.decorator';
import { AppUserRole } from '../../auth/decorators/roles.decorator';
import { ConversationService } from '../services/conversation.service';
import { PromptOrchestrationService } from '../services/prompt-orchestration.service';
import { SafetyGuardrailService } from '../services/safety-guardrail.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { AiMetricsService } from '../metrics/ai-metrics.service';
import {
  AiUsageEndpoint,
  AiUsageStatus,
} from '../entities/ai-usage-log.entity';
import { AiConfig } from '../config/ai.config';

interface AuthenticatedRequestUser {
  userId: string;
  address: string;
  user: { id: string; role?: AppUserRole } | null;
}

const roleOf = (currentUser: AuthenticatedRequestUser): AppUserRole =>
  currentUser.user?.role ?? 'contributor';

@ApiTags('ai-assistant')
@ApiBearerAuth('JWT-auth')
@Controller('ai-assistant/conversations')
@UseGuards(JwtAuthGuard)
export class AiStreamController {
  private readonly aiConfig: AiConfig;

  constructor(
    private readonly conversationService: ConversationService,
    private readonly promptOrchestrationService: PromptOrchestrationService,
    private readonly safetyGuardrailService: SafetyGuardrailService,
    private readonly cache: AiAssistantCache,
    private readonly metrics: AiMetricsService,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.get<AiConfig>('ai') as AiConfig;
  }

  private modelFor(providerName: string): string {
    return providerName === 'openai'
      ? this.aiConfig.openai.model
      : 'mock-model';
  }

  @Sse(':id/stream/:messageId')
  @ThrottleByWallet('aiStream')
  @ApiOperation({
    summary:
      'Stream an assistant reply for a message staged via POST .../messages/stream',
    description:
      'Server-Sent Events. Emits "citation" once, then "chunk" events, then a terminal "done" (or "error") event.',
  })
  stream(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
  ): Observable<MessageEvent> {
    const role = roleOf(currentUser);

    return new Observable<MessageEvent>((subscriber) => {
      let innerSubscription: { unsubscribe: () => void } | undefined;
      let settled = false;

      const emitErrorAndComplete = (code: string, message: string) => {
        if (settled) return;
        settled = true;
        subscriber.next({ type: 'error', data: { code, message } });
        subscriber.complete();
      };

      (async () => {
        const marker = await this.cache.getStreamPending(messageId);
        if (
          !marker ||
          marker.conversationId !== conversationId ||
          marker.userId !== currentUser.userId
        ) {
          throw new NotFoundException(
            'No pending message found for this stream. Stage a message first.',
          );
        }

        const conversation = await this.conversationService.findOwned(
          currentUser.userId,
          conversationId,
        );
        const start = Date.now();

        const prepared = await this.promptOrchestrationService.prepareStream({
          conversation,
          requesterRole: role,
          userContent: marker.content,
        });

        if (prepared.blocked) {
          const assistantMessage =
            await this.conversationService.finalizeAssistantMessage({
              conversation,
              userId: currentUser.userId,
              content: prepared.refusalContent,
              citations: [],
              provider: 'none',
              model: 'none',
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              latencyMs: Date.now() - start,
              flagged: true,
              flagReason: prepared.flagReason,
              endpoint: AiUsageEndpoint.STREAM,
              status: AiUsageStatus.SAFETY_BLOCKED,
            });
          await this.cache.clearStreamPending(messageId);
          settled = true;
          subscriber.next({
            type: 'done',
            data: { message: assistantMessage, fallback: false },
          });
          subscriber.complete();
          return;
        }

        subscriber.next({
          type: 'citation',
          data: { citations: prepared.citations },
        });

        let assembledContent = '';
        let index = 0;
        let usage:
          | {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
            }
          | undefined;

        innerSubscription = prepared.stream.subscribe({
          next: (chunk) => {
            assembledContent += chunk.delta;
            subscriber.next({
              type: 'chunk',
              data: { delta: chunk.delta, index: index++ },
            });
            if (chunk.usage) {
              usage = chunk.usage;
            }
          },
          error: async (error: Error) => {
            this.metrics.recordRequest(
              prepared.providerName,
              'stream',
              'error',
            );
            await this.conversationService.finalizeAssistantMessage({
              conversation,
              userId: currentUser.userId,
              content: '',
              citations: prepared.citations,
              provider: prepared.providerName,
              model: this.modelFor(prepared.providerName),
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              latencyMs: Date.now() - start,
              flagged: false,
              endpoint: AiUsageEndpoint.STREAM,
              status: AiUsageStatus.ERROR,
            });
            await this.cache.clearStreamPending(messageId);
            emitErrorAndComplete(
              'PROVIDER_ERROR',
              'The assistant failed to respond. Please try again.',
            );
          },
          complete: async () => {
            let finalContent = assembledContent;
            let flagged = false;
            let flagReason: string | undefined;
            if (
              this.safetyGuardrailService.containsCanaryLeak(
                finalContent,
                prepared.canaryToken,
              )
            ) {
              finalContent = this.safetyGuardrailService.LEAK_REFUSAL_MESSAGE;
              flagged = true;
              flagReason = 'prompt_leak_detected';
            }

            const assistantMessage =
              await this.conversationService.finalizeAssistantMessage({
                conversation,
                userId: currentUser.userId,
                content: finalContent,
                citations: prepared.citations,
                provider: prepared.providerName,
                model: this.modelFor(prepared.providerName),
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: usage?.completionTokens ?? 0,
                totalTokens: usage?.totalTokens ?? 0,
                latencyMs: Date.now() - start,
                flagged,
                flagReason,
                endpoint: AiUsageEndpoint.STREAM,
                status: AiUsageStatus.SUCCESS,
              });
            await this.cache.clearStreamPending(messageId);

            this.metrics.recordRequest(
              prepared.providerName,
              'stream',
              prepared.fallback ? 'fallback' : 'success',
            );
            this.metrics.observeLatency(
              prepared.providerName,
              'stream',
              (Date.now() - start) / 1000,
            );
            this.metrics.recordTokens(
              prepared.providerName,
              'prompt',
              usage?.promptTokens ?? 0,
            );
            this.metrics.recordTokens(
              prepared.providerName,
              'completion',
              usage?.completionTokens ?? 0,
            );

            settled = true;
            subscriber.next({
              type: 'done',
              data: { message: assistantMessage, fallback: prepared.fallback },
            });
            subscriber.complete();
          },
        });
      })().catch(async (error) => {
        await this.cache.clearStreamPending(messageId);
        const code =
          error instanceof NotFoundException ? 'NOT_FOUND' : 'INTERNAL_ERROR';
        emitErrorAndComplete(
          code,
          error.message || 'Unexpected error while starting the stream.',
        );
      });

      return () => {
        innerSubscription?.unsubscribe();
      };
    });
  }
}
