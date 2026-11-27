import { firstValueFrom, of, throwError } from 'rxjs';
import { AuditLoggingInterceptor } from './audit-logging.interceptor';
import {
  AuditActionType,
  AuditEntityType,
} from '../entities/audit-log.entity';

const SECRET = 'canary-webhook-secret';

describe('AuditLoggingInterceptor redaction (PREWAVE-BE-169)', () => {
  const metadata = {
    actionType: AuditActionType.CONFIG_UPDATED,
    entityType: AuditEntityType.USER,
    entityIdPath: 'args[0].id',
    captureBeforeState: true,
    captureAfterState: true,
    descriptionTemplate: 'Webhook updated: ${secret}',
  };

  function setup() {
    const reflector = { get: jest.fn(() => metadata) };
    const audit = { log: jest.fn(async (_entry: Record<string, any>) => undefined) };
    const request = { user: { id: 'user-1' }, get: jest.fn() };
    const interceptor = new AuditLoggingInterceptor(
      reflector as never,
      audit as never,
      request as never,
    );
    const context = {
      getArgs: () => [{ id: 'entity-1', secret: SECRET }],
      getHandler: () => () => undefined,
      getClass: () => class TestController {},
    };
    return { interceptor, audit, context };
  }

  it('redacts secrets from before/after snapshots and descriptions', async () => {
    const { interceptor, audit, context } = setup();
    const next = {
      handle: () => of({ secret: SECRET, webhookConfig: { url: 'https://x', secret: SECRET } }),
    };

    await firstValueFrom(interceptor.intercept(context as never, next as never));

    expect(audit.log).toHaveBeenCalledTimes(1);
    const record = audit.log.mock.calls[0][0];
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(SECRET);
    expect(record.beforeState.secret).toBe('[REDACTED]');
    expect(record.afterState.webhookConfig.secret).toBe('[REDACTED]');
  });

  it('redacts secrets from exception messages recorded in audit metadata', async () => {
    const { interceptor, audit, context } = setup();
    const next = {
      handle: () => throwError(() => new Error(`Failed with secret=${SECRET}`)),
    };

    await firstValueFrom(
      interceptor.intercept(context as never, next as never),
    ).catch(() => undefined);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(audit.log.mock.calls[0][0]);
    expect(serialized).not.toContain(SECRET);
  });
});
