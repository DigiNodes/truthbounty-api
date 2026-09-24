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
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles, AppUserRole } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { KnowledgeBaseService } from '../services/knowledge-base.service';
import { CreateContextDocumentDto } from '../dto/create-context-document.dto';
import { UpdateContextDocumentDto } from '../dto/update-context-document.dto';
import { ContextDocumentQueryDto } from '../dto/context-document-query.dto';
import { AiResponseInterceptor } from '../common/interceptors/ai-response.interceptor';
import { AiExceptionFilter } from '../common/filters/ai-exception.filter';

interface AuthenticatedRequestUser {
  userId: string;
  address: string;
  user: { id: string; role?: AppUserRole } | null;
}

const WRITE_ROLES: AppUserRole[] = ['admin', 'moderator'];

@ApiTags('ai-assistant')
@ApiBearerAuth('JWT-auth')
@Controller('ai-assistant/knowledge-base')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AiResponseInterceptor)
@UseFilters(AiExceptionFilter)
export class AiKnowledgeBaseController {
  constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

  @Get()
  @ApiOperation({
    summary: 'List knowledge-base documents used for context retrieval',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of documents' })
  async list(@Query() query: ContextDocumentQueryDto) {
    const { items, total } = await this.knowledgeBaseService.list(query);
    return {
      data: { items, total },
      meta: { limit: query.limit ?? 20, offset: query.offset ?? 0 },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single knowledge-base document' })
  @ApiResponse({ status: 200, description: 'Document found' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async findOne(@Param('id') id: string) {
    return this.knowledgeBaseService.findOne(id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(...WRITE_ROLES)
  @ApiOperation({
    summary: 'Create a knowledge-base document (moderator/admin only)',
  })
  @ApiResponse({ status: 201, description: 'Document created' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async create(
    @CurrentUser() currentUser: AuthenticatedRequestUser,
    @Body() dto: CreateContextDocumentDto,
  ) {
    return this.knowledgeBaseService.create(currentUser.userId, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(...WRITE_ROLES)
  @ApiOperation({
    summary: 'Update a knowledge-base document (moderator/admin only)',
  })
  @ApiResponse({ status: 200, description: 'Document updated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateContextDocumentDto) {
    return this.knowledgeBaseService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(...WRITE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Deactivate a knowledge-base document (moderator/admin only)',
  })
  @ApiResponse({ status: 204, description: 'Document deactivated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Document not found' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.knowledgeBaseService.remove(id);
  }
}
