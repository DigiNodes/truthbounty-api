import { Injectable, Logger } from '@nestjs/common';
import { Server as SocketServer } from 'socket.io';
import { NotificationChannel, ChannelDeliveryResult, RenderedNotificationPayload } from './channel.interface';

/**
 * WebSocketChannel
 * 
 * Delivers notifications in real-time via WebSocket (Socket.io).
 * 
 * Features:
 * - Real-time delivery to connected clients
 * - No retry (ephemeral delivery - if client disconnected, notification is lost)
 * - Low latency (under 100ms typical)
 * - Ideal for dashboard alerts and live updates
 * 
 * Design:
 * - SocketServer instance injected globally
 * - Emits to user's socket room: `user:${userId}`
 */
@Injectable()
export class WebSocketChannel implements NotificationChannel {
  readonly channelType = 'WEBSOCKET';
  private readonly logger = new Logger(WebSocketChannel.name);

  private socketServer: SocketServer;

  constructor() {
    // SocketServer will be injected via setSocketServer method
  }

  /**
   * Set the global Socket.io server instance
   * Called during module initialization
   */
  setSocketServer(server: SocketServer): void {
    this.socketServer = server;
    this.logger.log('WebSocket channel initialized with Socket.io server');
  }

  async isEnabled(userId: string): Promise<boolean> {
    // WebSocket channel is always available if server is initialized
    return !!this.socketServer;
  }

  async send(payload: RenderedNotificationPayload): Promise<ChannelDeliveryResult> {
    try {
      if (!this.socketServer) {
        return {
          success: false,
          error: 'WebSocket server not initialized',
        };
      }

      // Emit to user's socket room
      const room = `user:${payload.userId}`;

      const notification = {
        id: payload.metadata.notificationId || `ws-${Date.now()}`,
        eventType: payload.eventType,
        timestamp: new Date().toISOString(),
        title: payload.rendered.subject || payload.rendered.title,
        message: payload.rendered.body,
        html: payload.rendered.html,
        actionUrl: payload.rendered.actionUrl,
        metadata: payload.metadata,
      };

      this.socketServer.to(room).emit('notification:new', notification);

      this.logger.debug(
        `WebSocket notification emitted to ${room} (id: ${notification.id})`,
      );

      return {
        success: true,
        deliveryTimestamp: new Date(),
        channelMessageId: notification.id,
      };
    } catch (error) {
      this.logger.error(
        `Failed to emit WebSocket notification to ${payload.userId}: ${error.message}`,
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    // WebSocket has no configuration requirements
    const errors: string[] = [];

    if (!this.socketServer) {
      errors.push('WebSocket server not initialized');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get metrics on connected clients
   */
  async getMetrics(): Promise<any> {
    if (!this.socketServer) {
      return { connectedClients: 0, rooms: {} };
    }

    const sockets = await this.socketServer.fetchSockets();
    const connectedClients = sockets.length;

    // Count users by room
    const rooms: Record<string, number> = {};
    for (const socket of sockets) {
      for (const room of socket.rooms) {
        if (room.startsWith('user:')) {
          rooms[room] = (rooms[room] || 0) + 1;
        }
      }
    }

    return {
      connectedClients,
      userRooms: Object.keys(rooms).length,
      rooms,
    };
  }
}
