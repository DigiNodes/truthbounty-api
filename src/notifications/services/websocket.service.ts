import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { Notification } from '../entities/notification.entity';
import { DeliveryResult, DeliveryStatus } from '../interfaces/notification.types';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class WebSocketService implements OnModuleInit {
  private readonly logger = new Logger(WebSocketService.name);
  private server: Server;
  private userSockets: Map<string, Set<string>> = new Map();

  constructor(private readonly redisService: RedisService) {}

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
    const port = process.env.WEBSOCKET_PORT || 3001;
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
    this.userSockets.get(userId).add(socketId);
    
    await this.redisService.sAdd(`active_sockets:${userId}`, socketId);
  }

  private async removeUserSocket(socketId: string) {
    for (const [userId, sockets] of this.userSockets.entries()) {
      if (sockets.has(socketId)) {
        sockets.delete(socketId);
        await this.redisService.sRemove(`active_sockets:${userId}`, socketId);
        
        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
        break;
      }
    }
  }

  async isUserOnline(userId: string): Promise<boolean> {
    const sockets = await this.redisService.sMembers(`active_sockets:${userId}`);
    return sockets && sockets.length > 0;
  }

  async sendToUser(userId: string, event: string, data: any): Promise<number> {
    const userRoom = `user:${userId}`;
    const sockets = await this.server.in(userRoom).allSockets();
    const recipientCount = sockets.size;
    
    this.server.to(userRoom).emit(event, data);
    this.logger.debug(`Sent ${event} to user ${userId}, ${recipientCount} recipients`);
    
    return recipientCount;
  }

  async broadcastNotification(notification: Notification): Promise<DeliveryResult> {
    try {
      const isOnline = await this.isUserOnline(notification.userId);
      
      if (!isOnline) {
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: 'User is not connected to WebSocket',
        };
      }
      
      const recipientCount = await this.sendToUser(
        notification.userId,
        'notification:new',
        notification
      );
      
      if (recipientCount > 0) {
        return {
          success: true,
          status: DeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
        };
      } else {
        return {
          success: false,
          status: DeliveryStatus.FAILED,
          error: 'No active connections found for user',
        };
      }
    } catch (error) {
      this.logger.error(`Failed to send WebSocket notification`, error);
      return {
        success: false,
        status: DeliveryStatus.FAILED,
        error: error.message,
      };
    }
  }

  async broadcastGlobal(event: string, data: any): Promise<void> {
    this.server.emit(event, data);
    this.logger.debug(`Broadcast global event ${event} to all connected clients`);
  }

  getConnectedUsersCount(): number {
    return this.userSockets.size;
  }

  getTotalConnections(): number {
    let total = 0;
    for (const sockets of this.userSockets.values()) {
      total += sockets.size;
    }
    return total;
  }
}