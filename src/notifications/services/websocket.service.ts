import { Injectable, Logger } from '@nestjs/common';
import { Notification } from '../entities/notification.entity';
import { NotificationGateway } from '../websockets/websocket.gateway';
import { DeliveryStatus } from '../interfaces/notification.types';

@Injectable()
export class WebSocketService {
  private readonly logger = new Logger(WebSocketService.name);

  constructor(private readonly notificationGateway: NotificationGateway) {}

  /**
   * Broadcasts a notification to a user's connected WebSocket clients.
   *
   * If the user is online, the notification is sent immediately.
   * If the user is offline, the notification is not sent, and the method
   * returns a status indicating that the delivery should be retried later.
   */
  async broadcastNotification(notification: Notification): Promise<{
    success: boolean;
    status: DeliveryStatus;
    deliveredAt?: Date;
    error?: string;
  }> {
    const { userId, id: notificationId } = notification;

    if (!this.notificationGateway.isUserOnline(userId)) {
      this.logger.debug(
        `User ${userId} is offline. WebSocket notification ${notificationId} will be queued.`,
      );
      return {
        success: false,
        status: DeliveryStatus.PENDING,
        error: 'User is not online',
      };
    }

    try {
      const delivered = this.notificationGateway.sendToUser(
        userId,
        notification,
      );
      if (delivered) {
        this.logger.log(
          `Successfully sent notification ${notificationId} to user ${userId} via WebSocket.`,
        );
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
        };
      } else {
        this.logger.warn(
          `Failed to send notification ${notificationId} to user ${userId} via WebSocket.`,
        );
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: 'Failed to send notification',
        };
      }
    } catch (error) {
      this.logger.error(
        `Error sending WebSocket notification ${notificationId} to user ${userId}:`,
        error,
      );
      return {
        success: false,
        status: DeliveryStatus.FAILED,
        error: error.message,
      };
    }
  }
}
