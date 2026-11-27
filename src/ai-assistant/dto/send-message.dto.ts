import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Intentionally has no `role` field: the server always assigns role:'user'
 * and is the only party that can place a system message ahead of it
 * (see PromptOrchestrationService.buildMessages) — this is part of the
 * prompt-injection defense, not an oversight.
 */
export class SendMessageDto {
  @ApiProperty({ description: 'User message content', maxLength: 4000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content: string;

  @ApiPropertyOptional({
    enum: ['openai', 'mock'],
    description:
      'Force a provider for this call. Admin users only; mock is restricted to local/test and authorized development tooling.',
  })
  @IsOptional()
  @IsIn(['openai', 'mock'])
  providerOverride?: 'openai' | 'mock';
}
