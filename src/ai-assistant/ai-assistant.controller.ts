import { Controller, Get, Post, Body, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AiAssistantService } from './services/ai-assistant.service';
import { CreateConversationDto, SendMessageDto } from './dto/ai-assistant.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ThrottleByWallet } from '../common/decorators/throttle-by-wallet.decorator';

@ApiTags('AI Assistant')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ai/conversations')
export class AiAssistantController {
  constructor(private readonly aiAssistantService: AiAssistantService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new AI conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created successfully.' })
  async createConversation(@CurrentUser() user: any, @Body() dto: CreateConversationDto) {
    return this.aiAssistantService.createConversation(user.id || user.userId || user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all conversations for the authenticated user' })
  @ApiResponse({ status: 200, description: 'List of conversations.' })
  async getConversations(@CurrentUser() user: any) {
    return this.aiAssistantService.getConversations(user.id || user.userId || user.sub);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Get messages for a specific conversation' })
  @ApiResponse({ status: 200, description: 'List of messages in the conversation.' })
  async getConversationMessages(@CurrentUser() user: any, @Param('id') conversationId: string) {
    return this.aiAssistantService.getConversationMessages(user.id || user.userId || user.sub, conversationId);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a message to the AI Assistant' })
  @ApiResponse({ status: 201, description: 'AI Assistant response.' })
  @ThrottleByWallet('ai')
  async sendMessage(
    @CurrentUser() user: any,
    @Param('id') conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.aiAssistantService.sendMessage(user.id || user.userId || user.sub, conversationId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a conversation' })
  @ApiResponse({ status: 200, description: 'Conversation deleted.' })
  async deleteConversation(@CurrentUser() user: any, @Param('id') conversationId: string) {
    return this.aiAssistantService.deleteConversation(user.id || user.userId || user.sub, conversationId);
  }
}
