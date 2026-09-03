import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { UpdatePreferencesDto } from '../dto';
import { 
  UserPreferenceSettings, 
  DeliveryChannel, 
  NotificationCategory 
} from '../interfaces/notification.types';

@Injectable()
export class NotificationPreferencesService {
  private readonly logger = new Logger(NotificationPreferencesService.name);

  constructor(
    @InjectRepository(NotificationPreference)
    private readonly preferencesRepository: Repository<NotificationPreference>,
  ) {}

  async getUserPreferences(userId: string): Promise<NotificationPreference> {
    let preferences = await this.preferencesRepository.findOne({
      where: { userId },
    });

    if (!preferences) {
      preferences = this.createDefaultPreferences(userId);
      await this.preferencesRepository.save(preferences);
      this.logger.debug(`Created default preferences for user ${userId}`);
    }

    return preferences;
  }

  async updateUserPreferences(
    userId: string, 
    updateDto: UpdatePreferencesDto
  ): Promise<NotificationPreference> {
    const preferences = await this.getUserPreferences(userId);
    
    if (updateDto.enabledChannels) {
      preferences.settings.enabledChannels = updateDto.enabledChannels;
    }
    
    if (updateDto.emailPreferences) {
      preferences.settings.emailPreferences = {
        ...preferences.settings.emailPreferences,
        ...updateDto.emailPreferences,
      };
    }
    
    if (updateDto.governanceAlerts !== undefined) {
      preferences.settings.governanceAlerts = updateDto.governanceAlerts;
    }
    
    if (updateDto.stakingAlerts !== undefined) {
      preferences.settings.stakingAlerts = updateDto.stakingAlerts;
    }
    
    if (updateDto.rewardNotifications !== undefined) {
      preferences.settings.rewardNotifications = updateDto.rewardNotifications;
    }
    
    if (updateDto.securityAlerts !== undefined) {
      preferences.settings.securityAlerts = updateDto.securityAlerts;
    }
    
    if (updateDto.categorySettings) {
      preferences.settings.categories = {
        ...preferences.settings.categories,
        ...updateDto.categorySettings,
      };
    }
    
    preferences.updatedAt = new Date();
    const updatedPreferences = await this.preferencesRepository.save(preferences);
    
    this.logger.log(`Updated preferences for user ${userId}`);
    return updatedPreferences;
  }

  private createDefaultPreferences(userId: string): NotificationPreference {
    const defaultSettings: UserPreferenceSettings = {
      enabledChannels: [DeliveryChannel.IN_APP, DeliveryChannel.WEBSOCKET, DeliveryChannel.EMAIL],
      categories: this.getDefaultCategorySettings(),
      emailPreferences: {
        digestEnabled: false,
        digestFrequency: 'daily',
      },
      governanceAlerts: true,
      stakingAlerts: true,
      rewardNotifications: true,
      securityAlerts: true,
    };

    const preferences = new NotificationPreference();
    preferences.userId = userId;
    preferences.settings = defaultSettings;
    preferences.createdAt = new Date();
    preferences.updatedAt = new Date();
    
    return preferences;
  }

  private getDefaultCategorySettings(): Record<NotificationCategory, boolean> {
    const categories = Object.values(NotificationCategory);
    return categories.reduce((acc, category) => {
      acc[category] = true;
      return acc;
    }, {} as Record<NotificationCategory, boolean>);
  }
}