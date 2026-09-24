import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class SchedulerService {
  @Cron('0 * * * *')
  async cleanExpiredJobs() {
    console.log('Cleaning expired jobs...');
  }

  @Cron('*/30 * * * * *')
  async refreshAnalytics() {
    console.log('Refreshing analytics...');
  }
}