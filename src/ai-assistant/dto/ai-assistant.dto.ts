import { IsString, IsNotEmpty, IsOptional, IsUUID, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateConversationDto {
  @ApiPropertyOptional({ description: 'Optional title for the conversation' })
  @IsString()
  @IsOptional()
  title?: string;
}

export class SendMessageDto {
  @ApiProperty({ description: 'The message content' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({ description: 'Optional list of tools to use (mocked)' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tools?: string[];
}
