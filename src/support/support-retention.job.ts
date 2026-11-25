import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupportRequestService } from './support.service';

/**
 * Scheduled job for purging expired support requests.
 *
 * PREWAVE-BE-106 (#807): Enforces 30-day retention policy by removing
 * expired support requests from the database.
 *
 * Runs daily at 2:00 AM to clean up expired records based on expiresAt timestamp.
 * This ensures:
 * - Privacy-sensitive data is not retained beyond policy
 * - Database storage is reclaimed from expired records
 * - Fingerprint duplicates are automatically cleaned up
 *
 * The job logs the number of purged records for operational visibility.
 */
@Injectable()
export class SupportRetentionJob {
  private readonly logger = new Logger(SupportRetentionJob.name);

  constructor(private readonly supportService: SupportRequestService) {}

  /**
   * Daily retention purge at 2:00 AM.
   *
   * Removes support requests where expiresAt <= now.
   * The default retention period is 30 days from creation.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async purgeExpiredSupportRequests(): Promise<void> {
    this.logger.log('Starting support request retention purge');

    try {
      const expiredIds = await this.supportService.cleanupExpiredSupportRequests();

      if (expiredIds.length === 0) {
        this.logger.log('No expired support requests to purge');
      } else {
        this.logger.log(
          `Purged ${expiredIds.length} expired support requests`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to purge expired support requests: ${error.message}`,
        error.stack,
      );
      // Do not throw - retention purge should not crash the application
      // The job will retry on the next scheduled run
    }
  }

  /**
   * Manual trigger for retention purge (for testing or operational needs).
   * Returns the list of purged record IDs.
   */
  async triggerManualPurge(): Promise<string[]> {
    this.logger.log('Manual support request retention purge triggered');
    return this.supportService.cleanupExpiredSupportRequests();
  }
}
