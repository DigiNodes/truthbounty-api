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
  onModuleInit() {
    this.initializeWebSocketServer();
  }

  private initializeWebSocketServer() {
    this.server = new Server({
      cors: {
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true,
      },
    });
    
    this.setupConnectionHandlers();
    const port = Number(process.env.WEBSOCKET_PORT) || 3001;
    this.server.listen(port);
    
    this.logger.log(`WebSocket server initialized on port ${port}`);
  }

  private setupConnectionHandlers() {
    this.server.on('connection', (socket) => {
      this.logger.debug(`New client connected: ${socket.id}`);
      
      socket.on('authenticate', async (userId: string) => {
        await this.registerUserSocket(userId, socket.id);
        socket.join(`user:${userId}`);
        this.logger.debug(`User ${userId} authenticated with socket ${socket.id}`);
      });
      
      socket.on('disconnect', async () => {
        await this.removeUserSocket(socket.id);
        this.logger.debug(`Client disconnected: ${socket.id}`);
      });
      
      socket.on('subscribe', (channels: string[]) => {
        channels.forEach(channel => socket.join(channel));
        this.logger.debug(`Socket ${socket.id} subscribed to channels: ${channels.join(', ')}`);
      });
      
      socket.on('unsubscribe', (channels: string[]) => {
        channels.forEach(channel => socket.leave(channel));
        this.logger.debug(`Socket ${socket.id} unsubscribed from channels: ${channels.join(', ')}`);
      });
    });
  }

  private async registerUserSocket(userId: string, socketId: string) {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)?.add(socketId);
    
    await this.redisService.sAdd(`active_sockets:${userId}`, socketId);
  }

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
  }

  async isUserOnline(userId: string): Promise<boolean> {
    const sockets = await this.redisService.sMembers(`active_sockets:${userId}`);
    return Array.isArray(sockets) && sockets.length > 0;
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
