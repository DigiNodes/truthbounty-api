import {
  Controller,
  Get,
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
import { Roles } from '../../auth/decorators/roles.decorator';
import { UsageAnalyticsService } from '../services/usage-analytics.service';
import { UsageAnalyticsQueryDto } from '../dto/usage-analytics-query.dto';
import { AiResponseInterceptor } from '../common/interceptors/ai-response.interceptor';
import { AiExceptionFilter } from '../common/filters/ai-exception.filter';

@ApiTags('ai-assistant')
@ApiBearerAuth('JWT-auth')
@Controller('ai-assistant/analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(AiResponseInterceptor)
@UseFilters(AiExceptionFilter)
export class AiAnalyticsController {
  constructor(private readonly usageAnalyticsService: UsageAnalyticsService) {}

  @Get('usage')
  @ApiOperation({
    summary: 'AI assistant usage analytics summary (admin only)',
  })
  @ApiResponse({ status: 200, description: 'Usage summary' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  async usage(@Query() query: UsageAnalyticsQueryDto) {
    return this.usageAnalyticsService.getSummary(query);
  }
}
