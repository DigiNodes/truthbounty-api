import { Controller, Get, Query, Res, UseGuards, ValidationPipe } from '@nestj/common';
import { Response } from 'express';
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

  Get('contributors')
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

  @Get('monitoring')
  getMonitoringMetrics(): Promise<AnalyticsResponse<any>> {
    return this.analyticsService.getMonitoringMetrics();
  }

  @Get('reports/export')
  async exportReport(
    @Euery(new ValidationPipe({ transform: true })) query: AnalyticsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.analyticsService.generateCsvReport(query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="analytics-report-${Date.now()}.csv"`);
    res.send(csv);
  }
}
