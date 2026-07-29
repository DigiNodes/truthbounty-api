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

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

@WebSocketGateway({
  cors: {
    origin: '*', // Configure this appropriately for production
  },
  transports: ['websocket', 'polling'],
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationGateway.name);
  private userSockets: Map<string, Set<string>> = new Map(); // userId -> Set<socketIds>

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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

      // Add socket to user's set
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId).add(client.id);

      this.logger.log(`Client ${client.id} authenticated for user ${userId}`);
      
      // Send connection confirmation
      client.emit('connected', { userId, timestamp: new Date() });
      
    } catch (error) {
      this.logger.warn(`Invalid token from client ${client.id}: ${error.message}`);
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
      this.logger.log(`Client ${client.id} disconnected for user ${client.userId}`);
    }
  }

  /**
   * Broadcast a notification to a specific user's connected clients
   */
  sendToUser(userId: string, notification: Notification) {
    const userSocketSet = this.userSockets.get(userId);
    if (!userSocketSet || userSocketSet.size === 0) {
      this.logger.debug(`No active connections for user ${userId}, notification queued`);
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

  /**
   * Check if a user is currently online
   */
  isUserOnline(userId: string): boolean {
    const userSocketSet = this.userSockets.get(userId);
    return userSocketSet && userSocketSet.size > 0;
  }

  /**
   * Get number of connected users
   */
  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() channels: string[]) {
    this.logger.debug(`Client ${client.id} subscribed to channels: ${channels.join(', ')}`);
    channels.forEach((channel) => client.join(channel));
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() channels: string[]) {
    this.logger.debug(`Client ${client.id} unsubscribed from channels: ${channels.join(', ')}`);
    channels.forEach((channel) => client.leave(channel));
  }

  @SubscribeMessage('mark_read')
  handleMarkRead(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() notificationId: string) {
    // This will be handled by the notification service to update the database
    this.logger.debug(`User ${client.userId} marked notification ${notificationId} as read`);
  }
}