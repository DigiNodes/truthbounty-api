import { NotificationType, DeliveryChannel } from '../enums/notification-type.enum';

export interface NotificationPayload {
  type: NotificationType;
  userId: string;
  walletAddress?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  priority?: number;
  channels?: DeliveryChannel[];
  scheduledAt?: Date;
  templateName?: string;
  templateVariables?: Record<string, string>;
}

export interface DeliveryResult {
  success: boolean;
  channel: DeliveryChannel;
  deliveredAt?: Date;
  failureReason?: string;
  responseData?: Record<string, any>;
}