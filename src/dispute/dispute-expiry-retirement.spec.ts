jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { readFileSync } from 'fs';
import { join } from 'path';
import { DisputeService } from './dispute.service';
import { DisputeJournalStore } from './dispute-journal.store';
import { DisputeProjectionService } from './dispute-projection.service';
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

  it('refuses local expiry commands without writing workflow or projection state', () => {
    const store = { review: jest.fn(), create: jest.fn() };
    const projection = { snapshot: jest.fn() };
    const service = new DisputeService(
      store as unknown as DisputeJournalStore,
      projection as unknown as DisputeProjectionService,
    );
    expect(() => service.expireDispute('claim-1')).toThrow(
      'Only finalized contract events establish dispute expiry',
    );
    expect(store.review).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(projection.snapshot).not.toHaveBeenCalled();
  });

  it.each([
    '2026-01-03T00:00:00Z',
    '2026-01-04T00:00:00Z',
    '2027-01-01T00:00:00Z',
  ])('does not turn elapsed time into an expiry event at %s', (clock) => {
    const dispute = Object.freeze(row(DisputeStatus.RAISED));
    const now = new Date(clock);
    const lifecycle = toDisputeLifecycleView(dispute, DataState.FINALIZED, {
      now,
    });
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
    // Issue 865 mounts the replacement workflow/finalized-projection module.
    expect(imports).toMatch(/\bDisputeModule\s*,/);
    const module = readFileSync(join(__dirname, 'dispute.module.ts'), 'utf8');
    expect(module).toContain('DisputeProjectionService');
    expect(module).not.toContain('TypeOrmModule');
  });
});
