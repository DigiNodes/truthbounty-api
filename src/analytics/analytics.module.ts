import { Module } from '@nestjs/common';
import { AnalyticsConsentService } from './analytics-consent.service';
import { AnalyticsService } from './analytics.service';

@Module({
  providers: [AnalyticsConsentService, AnalyticsService],
  exports: [AnalyticsConsentService, AnalyticsService],
})
export class AnalyticsModule {}
