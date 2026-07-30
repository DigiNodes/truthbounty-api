import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ConversationMode } from '../entities/conversation.entity';

export class CreateConversationDto {
  @ApiPropertyOptional({
    description: 'Optional initial title for the conversation',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    enum: ConversationMode,
    default: ConversationMode.GENERAL,
    description:
      'Conversation mode. moderation_assist requires moderator/admin role; admin_analytics requires admin role.',
  })
  @IsOptional()
  @IsEnum(ConversationMode)
  mode?: ConversationMode;
}
