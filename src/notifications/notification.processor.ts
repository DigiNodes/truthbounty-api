import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationService } from './services/notification.service';

@Processor('notifications-queue')
@Injectable()
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly notificationService: NotificationService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.debug(`Processing notification job ${job.id}: ${job.name}`);

    switch (job.name) {
      case 'deliver-notification': {
        const { notificationId } = job.data;
        await this.notificationService.processDelivery(notificationId);
        return { success: true, notificationId };
      }
      default:
        throw new Error(`Unknown notification job name: ${job.name}`);
    }
  }
}
