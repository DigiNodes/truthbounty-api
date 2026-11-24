import { EventQuarantineController } from './event-quarantine.controller';
import { ROLES_KEY } from '../../admin/decorators/roles.decorator';
import { AdminRole } from '../../admin/entities/admin.entity';
import { IDEMPOTENT_KEY } from '../../common/idempotency/idempotent.decorator';

describe('EventQuarantineController (PREWAVE-BE-053)', () => {
  const quarantine = {
    list: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
    get: jest.fn().mockResolvedValue({ id: 'q-1' }),
  };
  const replay = {
    replay: jest.fn().mockResolvedValue({
      status: 'replayed',
      canonicalStatus: 'ingested',
      quarantineId: 'q-1',
      artifactVersion: '2.1.0',
    }),
  };

  const controller = new EventQuarantineController(
    quarantine as never,
    replay as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('delegates reads to the quarantine service', async () => {
    await controller.list({ status: undefined });
    expect(quarantine.list).toHaveBeenCalled();

    await controller.get('q-1');
    expect(quarantine.get).toHaveBeenCalledWith('q-1');
  });

  it('requires an admin identity for replay', async () => {
    await expect(
      controller.replayOne('q-1', { reason: 'reviewed' }, {}),
    ).rejects.toThrow('Admin identity is required');
  });

  it('forwards actor and reviewed artifact version to the replay service', async () => {
    await controller.replayOne(
      'q-1',
      { reason: 'reviewed', expectedArtifactVersion: '2.1.0' },
      { admin: { id: 'admin-1' } },
    );

    expect(replay.replay).toHaveBeenCalledWith('q-1', {
      actorId: 'admin-1',
      reason: 'reviewed',
      expectedArtifactVersion: '2.1.0',
    });
  });

  it('gates replay to super_admin/administrator and requires idempotency', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      EventQuarantineController.prototype.replayOne,
    );
    expect(roles).toEqual([AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR]);
    expect(
      Reflect.getMetadata(
        IDEMPOTENT_KEY,
        EventQuarantineController.prototype.replayOne,
      ),
    ).toBe(true);
  });
});
