import { Controller, Get, Query, UseGuards, ValidationPipe } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AnalyticsResponse } from './interfaces/analytics-response.interface';
import { GlobalAuthGuard } from '../auth/global-auth.guard'; // Assume standard auth guard exists

@Controller('analytics')
@UseGuards(GlobalAuthGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('protocol')
  getProtocolStatistics(@Query(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getProtocolStatistics(query);
  }

  @Get('contributors')
  getContributorAnalytics(@Query(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getContributorAnalytics(query);
  }

  @Get('claims')
  getClaimAnalytics(@Query(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getClaimAnalytics(query);
  }

  @Get('governance')
  getGovernanceAnalytics(@Query(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getGovernanceAnalytics(query);
  }

  @Get('rewards')
  getRewardAnalytics(@Query(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getRewardAnalytics(query);
  }

  @Get('trends')
  getTrendReporting(@Query(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getTrendReporting(query);
  }
}
