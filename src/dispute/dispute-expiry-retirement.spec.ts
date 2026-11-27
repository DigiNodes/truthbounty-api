import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource, Repository } from 'typeorm';
import { Dispute, DisputeTrigger } from './entities/dispute.entity';
import { DEFAULT_CONFIG, DisputeService } from './dispute.service';
import { DataState } from '../v2/common/data-state.enum';
import {
  DisputeStatus,
  ProjectDispute,
} from '../v2/disputes/entities/project-dispute.entity';
import { toDisputeLifecycleView } from '../v2/disputes/dispute-lifecycle';
import { toDisputeReadModelItem } from '../v2/disputes/read-models/dispute-read-model-view';

describe('Contract-owned dispute expiry (#868)', () => {
  const deadline = new Date('2026-01-04T00:00:00Z');
  const row = (status: DisputeStatus): ProjectDispute => ({
    disputeId: 'claim-1:round-1',
    claimId: 'claim-1',
    originalRoundId: 'round-1',
    appealRoundId: null,
    challengeBond: '1000',
    challengeBondAsset: 'token',
    status,
    deadline,
    resolvedOutcome: status === DisputeStatus.RESOLVED ? 'support' : null,
    dataState: DataState.FINALIZED,
    eventTxHash: `0x${'a'.repeat(64)}`,
    eventLogIndex: 1,
    blockNumber: '100',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: deadline,
  });

  it('exposes no local age policy, candidate query, or terminal expiry command', () => {
    expect(DEFAULT_CONFIG).not.toHaveProperty('MAX_DISPUTE_DURATION_HOURS');
    expect(DisputeService.prototype).not.toHaveProperty('expireDispute');
    expect(DisputeService.prototype).not.toHaveProperty('getExpiredDisputes');
  });

  it('preserves the upstream transactional duplicate check when creating disputes', async () => {
    const query = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const manager = {
      findOne: jest.fn().mockResolvedValue({ id: 'existing-dispute' }),
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(query),
      }),
      save: jest.fn(),
    };
    const transaction = jest.fn(async (callback) => callback(manager));
    const service = new DisputeService(
      {} as Repository<Dispute>,
      { transaction } as unknown as DataSource,
    );

    await expect(
      service.createDispute({
        claimId: 'claim-1',
        trigger: DisputeTrigger.MANUAL,
        originalConfidence: 0.4,
      }),
    ).rejects.toThrow('An open dispute already exists');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it.each([
    '2026-01-03T00:00:00Z',
    '2026-01-04T00:00:00Z',
    '2027-01-01T00:00:00Z',
  ])('does not turn elapsed time into an expiry event at %s', (clock) => {
    const dispute = Object.freeze(row(DisputeStatus.RAISED));
    const now = new Date(clock);
    const lifecycle = toDisputeLifecycleView(dispute, DataState.FINALIZED, { now });
    const readModel = toDisputeReadModelItem(dispute, {
      now,
      dataState: DataState.FINALIZED,
      provenance: {
        chainId: 11155420,
        releaseId: 'release-1',
        deploymentBlock: 1,
        artifactChecksum: 'f'.repeat(64),
      },
    });
    expect(lifecycle.final).toBeNull();
    expect(lifecycle.bond.disposition).toBe('locked');
    expect(readModel.outcome.final).toBeNull();
    expect(dispute.status).toBe(DisputeStatus.RAISED);
  });

  it.each([DisputeStatus.RESOLVED, DisputeStatus.EXPIRED])(
    'preserves the projected %s outcome across repeated late reads',
    (status) => {
      const dispute = Object.freeze(row(status));
      for (let retry = 0; retry < 3; retry++) {
        const view = toDisputeLifecycleView(dispute, DataState.FINALIZED, {
          now: new Date('2027-01-01T00:00:00Z'),
        });
        expect(view.final?.status).toBe(status);
        expect(view.final?.outcome).toBe(dispute.resolvedOutcome);
        expect(view.timeline[0].txHash).toBe(dispute.eventTxHash);
      }
    },
  );

  it('keeps production bootstrap on the canonical dispute modules', () => {
    // A source boundary check avoids booting unrelated external infrastructure.
    // Runtime startup remains covered by the application's bootstrap tests.
    const app = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');
    const imports = app.slice(app.indexOf('@Module('));
    expect(imports).toMatch(/\bV2DisputesModule\s*,/);
    expect(imports).toMatch(/\bDisputeReadModelsModule\s*,/);
    expect(imports).not.toMatch(/\bDisputeModule\s*,/);
  });
});
