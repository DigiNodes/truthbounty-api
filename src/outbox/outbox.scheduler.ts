import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';

/**
 * OutboxScheduler — periodic poller for the Transactional Outbox (V2-BE-048).
 *
 * Runs every 5 seconds (or on schedule) to claim PENDING outbox events
 * and relay them to BullMQ. Uses a simple lock guard to prevent concurrent
 * polling runs within the same instance.
 */
@Injectable()
export class OutboxScheduler {
  private readonly logger = new Logger(OutboxScheduler.name);
  private isProcessing = false;

  constructor(private readonly outboxService: OutboxService) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async handleOutboxCron(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Previous outbox polling run still active, skipping tick');
      return;
    }

    this.isProcessing = true;
    try {
      await this.outboxService.processOutbox();
    } catch (error) {
      this.logger.error(`Error processing outbox: ${error?.message}`, error?.stack);
    } finally {
      this.isProcessing = false;
    }
  }
}
