import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ThrottleByWallet } from '../../common/decorators/throttle-by-wallet.decorator';
import { AppUserRole } from '../../auth/decorators/roles.decorator';
import { ConversationService } from '../services/conversation.service';
import { AiAssistantCache } from '../cache/ai-assistant.cache';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { ConversationQueryDto } from '../dto/conversation-query.dto';
import { SendMessageDto } from '../dto/send-message.dto';
import { StageStreamMessageDto } from '../dto/stage-stream-message.dto';
import { AiResponseInterceptor } from '../common/interceptors/ai-response.interceptor';
import { AiExceptionFilter } from '../common/filters/ai-exception.filter';

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
@UseInterceptors(AiResponseInterceptor)
@UseFilters(AiExceptionFilter)
export class AiConversationsController {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly cache: AiAssistantCache,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new AI assistant conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  async create(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationService.create(
      currentUser.userId,
      roleOf(currentUser),
      dto,
    );
  }

  @Get()
  @ApiOperation({ summary: "List the current user's conversations" })
  @ApiResponse({ status: 200, description: 'Paginated list of conversations' })
  async list(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Query() query: ConversationQueryDto,
  ) {
    const { items, total } = await this.conversationService.list(
      currentUser.userId,
      query,
    );
    return {
      data: { items, total },
      meta: { limit: query.limit ?? 20, offset: query.offset ?? 0 },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single conversation' })
  @ApiResponse({ status: 200, description: 'Conversation found' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async findOne(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') id: string,
  ) {
    return this.conversationService.findOwned(currentUser.userId, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Get the message history for a conversation' })
  @ApiResponse({ status: 200, description: 'Message history' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async listMessages(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') id: string,
  ) {
    return this.conversationService.listMessages(currentUser.userId, id);
  }

  @Patch(':id/archive')
  @ApiOperation({ summary: 'Archive a conversation' })
  @ApiResponse({ status: 200, description: 'Conversation archived' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async archive(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') id: string,
  ) {
    return this.conversationService.archive(currentUser.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a conversation' })
  @ApiResponse({ status: 204, description: 'Conversation deleted' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async remove(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.conversationService.remove(currentUser.userId, id);
  }

  @Post(':id/messages')
  @ThrottleByWallet('ai')
  @ApiOperation({
    summary: 'Send a message and get a non-streaming assistant reply',
  })
  @ApiResponse({ status: 201, description: 'Assistant reply generated' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async sendMessage(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    const result = await this.conversationService.sendMessage(
      currentUser.userId,
      roleOf(currentUser),
      id,
      dto,
    );
    return { data: result, meta: { fallback: result.fallback } };
  }

  @Post(':id/messages/stream')
  @ThrottleByWallet('aiStream')
  @ApiOperation({
    summary: 'Stage a message for a streamed assistant reply',
    description:
      'Returns a messageId and streamUrl to open with GET .../stream/:messageId (Server-Sent Events).',
  })
  @ApiResponse({ status: 202, description: 'Message staged for streaming' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  @HttpCode(HttpStatus.ACCEPTED)
  async stageStreamMessage(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Param('id') id: string,
    @Body() dto: StageStreamMessageDto,
  ) {
    const userMessage = await this.conversationService.stageStreamMessage(
      currentUser.userId,
      id,
      dto.content,
    );
    await this.cache.setStreamPending({
      conversationId: id,
      messageId: userMessage.id,
      userId: currentUser.userId,
      content: dto.content,
    });
    return {
      messageId: userMessage.id,
      streamUrl: `/ai-assistant/conversations/${id}/stream/${userMessage.id}`,
    };
  }
}
