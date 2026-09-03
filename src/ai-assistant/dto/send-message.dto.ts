import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
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
      'Force a specific provider for this call. Only honored for admin users.',
  })
  @IsOptional()
  @IsIn(['openai', 'mock'])
  providerOverride?: 'openai' | 'mock';
}
