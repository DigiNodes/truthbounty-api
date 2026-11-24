import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { GracefulShutdownService } from '../../common/lifecycle/graceful-shutdown.service';
import { NotificationsService } from '../services/notifications.service';
import { NotificationGateway } from './websocket.gateway';

describe('NotificationGateway shutdown', () => {
  it('notifies and disconnects websocket clients during drain', async () => {
    const shutdown = new GracefulShutdownService();
    const gateway = new NotificationGateway(
      {} as JwtService,
      {} as ConfigService,
      {} as NotificationsService,
      shutdown,
    );
    const server = {
      emit: jest.fn(),
      disconnectSockets: jest.fn(),
    };
    gateway.server = server as never;
    gateway.onModuleInit();

    await shutdown.shutdown(async () => undefined);

    expect(server.emit).toHaveBeenCalledWith('server_shutdown', {
      retryable: true,
    });
    expect(server.disconnectSockets).toHaveBeenCalledWith(true);
  });
});
