import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { Roles } from '../admin/decorators/roles.decorator';
import { AdminRole } from '../admin/entities/admin.entity';
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
  createSupportRequest(@Body() dto: CreateSupportRequestDto) {
    return this.supportService.createSupportRequest(dto);
  }

  @Public()
  @Get('requests')
  @ApiOperation({ summary: 'List retained support requests' })
  @ApiQuery({ name: 'contact', required: false })
  listSupportRequests(@Query('contact') contact?: string) {
    const requests = this.supportService.listSupportRequests();
    if (!contact) return requests;
    return requests.filter((record) => record.contact === contact);
  }

  @Public()
  @Get('requests/:id')
  @ApiOperation({ summary: 'Fetch a support request by id' })
  getSupportRequest(@Param('id') id: string) {
    return this.supportService.getSupportRequest(id);
  }

  @Delete('requests/:id')
  @UseGuards(JwtAuthGuard, AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete a support request by id',
    description:
      'Hard-deletes the targeted support request and clears its deduplication fingerprint.',
  })
  @ApiResponse({ status: 200, description: 'Targeted deletion result' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  deleteSupportRequest(@Param('id') id: string) {
    return this.supportService.deleteSupportRequest(id);
  }
}
