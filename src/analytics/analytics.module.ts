import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsConsentService } from './analytics-consent.service';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [PrismaModule],
  providers: [AnalyticsConsentService, AnalyticsService],
  exports: [AnalyticsConsentService, AnalyticsService],
})
export class AnalyticsModule {}
