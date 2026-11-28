import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';
import { SupportRequestService } from './support.service';

@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportRequestService) {}

  @Public()
  @Post('requests')
  @ApiOperation({
    summary: 'Submit a privacy-safe support request',
    description:
      'Accepts minimal support data while rejecting secrets, private keys, and non-public evidence before storage.',
  })
  @ApiResponse({ status: 201, description: 'Support request accepted' })
  async createSupportRequest(@Body() dto: CreateSupportRequestDto) {
    return this.supportService.createSupportRequest(dto);
  }

  @Get('requests')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List retained support requests (support staff only)',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Support staff role required' })
  async listSupportRequests(@Request() request) {
    return this.supportService.listSupportRequests(request.user);
  }

  @Get('requests/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Fetch a support request by id (support staff only)',
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Support staff role required' })
  async getSupportRequest(@Param('id') id: string, @Request() request) {
    return this.supportService.getSupportRequest(id, request.user);
  }

  @Delete('requests/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('moderator', 'admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a support request (support staff only)' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Support staff role required' })
  async deleteSupportRequest(@Param('id') id: string, @Request() request) {
    return {
      deleted: await this.supportService.deleteSupportRequest(id, request.user),
      id,
    };
  }
}
