import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationStatus } from './enums/notification-status.enum';
import { NotificationChannel } from './enums/notification-channel.enum';

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    @InjectRepository(NotificationPreference)
    private preferenceRepository: Repository<NotificationPreference>,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { notificationId } = job.data;
    this.logger.debug(`Processing notification ${notificationId}`);

    const notification = await this.notificationRepository.findOne({ where: { id: notificationId } });
    if (!notification) {
      this.logger.error(`Notification ${notificationId} not found`);
      return;
    }

    try {
      let pref = await this.preferenceRepository.findOne({ where: { userId: notification.userId } });
      if (!pref) {
        pref = this.preferenceRepository.create({ userId: notification.userId });
        await this.preferenceRepository.save(pref);
      }

      // Check category preferences
      if (pref.disabledCategories && pref.disabledCategories.includes(notification.category)) {
        this.logger.debug(`Notification ${notificationId} skipped due to disabled category ${notification.category}`);
        notification.status = NotificationStatus.DISMISSED;
        await this.notificationRepository.save(notification);
        return;
      }

      // Determine delivery channel
      let channelToUse = notification.channel;
      if (!channelToUse) {
        // Fallback to IN_APP if no channel is explicitly provided, or use user's preferred channels
        channelToUse = (pref.enabledChannels && pref.enabledChannels.length > 0) ? pref.enabledChannels[0] as NotificationChannel : NotificationChannel.IN_APP;
      } else {
        if (pref.enabledChannels && !pref.enabledChannels.includes(channelToUse)) {
          this.logger.debug(`Notification ${notificationId} skipped due to disabled channel ${channelToUse}`);
          notification.status = NotificationStatus.DISMISSED;
          await this.notificationRepository.save(notification);
          return;
        }
      }

      // Update notification with channel if it was missing
      notification.channel = channelToUse;

      // Simulate quiet hours logic (simplified)
      if (pref.quietHoursEnabled && pref.quietHoursStart && pref.quietHoursEnd) {
        // In a real implementation, we would compare current time with quiet hours
        // and optionally throw a delay error to queue it for later.
        // this.logger.debug(`Quiet hours check for user ${notification.userId}`);
      }

      // Simulate delivery based on channel
      this.logger.log(`Delivering notification ${notificationId} via ${channelToUse}`);
      
      // Simulate failure randomly for testing retry mechanism (e.g. 10% chance)
      // if (Math.random() < 0.1) {
      //   throw new Error('Simulated network failure');
      // }

      notification.status = NotificationStatus.DELIVERED;
      await this.notificationRepository.save(notification);
      this.logger.log(`Successfully delivered notification ${notificationId}`);
    } catch (error) {
      this.logger.error(`Failed to deliver notification ${notificationId}: ${error.message}`);
      notification.retryCount += 1;
      notification.errorMessage = error.message;
      
      if (job.attemptsMade >= (job.opts.attempts || 1)) {
        notification.status = NotificationStatus.FAILED;
      }
      
      await this.notificationRepository.save(notification);
      throw error; // Let BullMQ handle retry
    }
  }
}
