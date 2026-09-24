import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Notification } from '../entities/notification.entity';
import { NotificationsService } from '../services/notifications.service';

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  transports: ['websocket', 'polling'],
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationGateway.name);
  private userSockets: Map<string, Set<string>> = new Map();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async handleConnection(@ConnectedSocket() client: AuthenticatedSocket) {
    try {
      const token = client.handshake.auth.token || client.handshake.query.token;

      if (!token) {
        this.logger.warn(`Client ${client.id} connected without token`);
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get('JWT_SECRET'),
      });

      const userId = payload.sub;
      client.userId = userId;

      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId).add(client.id);

      this.logger.log(`Client ${client.id} authenticated for user ${userId}`);

      client.emit('connected', { userId, timestamp: new Date() });

      // Fetch and send unread notifications
      this.sendUnreadNotifications(userId);
    } catch (error) {
      this.logger.warn(
        `Invalid token from client ${client.id}: ${error.message}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect(@ConnectedSocket() client: AuthenticatedSocket) {
    if (client.userId) {
      const userSocketSet = this.userSockets.get(client.userId);
      if (userSocketSet) {
        userSocketSet.delete(client.id);
        if (userSocketSet.size === 0) {
          this.userSockets.delete(client.userId);
        }
      }
      this.logger.log(
        `Client ${client.id} disconnected for user ${client.userId}`,
      );
    }
  }

  sendToUser(userId: string, notification: Notification) {
    const userSocketSet = this.userSockets.get(userId);
    if (!userSocketSet || userSocketSet.size === 0) {
      this.logger.debug(
        `No active connections for user ${userId}, notification queued`,
      );
      return false;
    }

    this.logger.debug(
      `Broadcasting notification ${notification.id} to ${userSocketSet.size} clients for user ${userId}`,
    );

    userSocketSet.forEach((socketId) => {
      this.server.to(socketId).emit('notification', notification);
    });

    return true;
  }

  isUserOnline(userId: string): boolean {
    const userSocketSet = this.userSockets.get(userId);
    return userSocketSet && userSocketSet.size > 0;
  }

  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() channels: string[],
  ) {
    this.logger.debug(
      `Client ${client.id} subscribed to channels: ${channels.join(', ')}`,
    );
    channels.forEach((channel) => client.join(channel));
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() channels: string[],
  ) {
    this.logger.debug(
      `Client ${client.id} unsubscribed from channels: ${channels.join(', ')}`,
    );
    channels.forEach((channel) => client.leave(channel));
  }

  @SubscribeMessage('mark_read')
  handleMarkRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() notificationId: string,
  ) {
    this.logger.debug(
      `User ${client.userId} marked notification ${notificationId} as read`,
    );
  }

  private async sendUnreadNotifications(userId: string) {
    const unreadNotifications =
      await this.notificationsService.getUnreadNotifications(userId);
    if (unreadNotifications.length > 0) {
      this.logger.log(
        `Sending ${unreadNotifications.length} unread notifications to user ${userId}`,
      );
      unreadNotifications.forEach((notification) => {
        this.sendToUser(userId, notification);
      });
    }
  }
}
