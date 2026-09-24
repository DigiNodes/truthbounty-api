/* eslint-disable @typescript-eslint/no-unsafe-return -- mock repos return plain objects */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ClaimProjectorService } from './claim-projector.service';
import { ClaimLifecycleEvent } from './entities/claim-lifecycle-event.entity';
import { ClaimReadModel } from './entities/claim-read-model.entity';
import { ClaimLifecycleEventType } from '../domain/claim/canonical-claim-event';
import { ClaimState } from '../domain/claim/claimState';

describe('ClaimProjectorService', () => {
  let service: ClaimProjectorService;
  let eventRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let readModelRepo: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  const baseEvent = (overrides: Partial<any> = {}) => ({
    type: ClaimLifecycleEventType.SUBMITTED,
    claimId: 'claim-1',
    chainId: '10',
    blockNumber: 100,
    eventIndex: 1,
    logIndex: 0,
    txHash: '0xabc',
    blockTimestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    eventRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((e) => e),
      save: jest.fn((e) => Promise.resolve(e)),
      find: jest.fn().mockResolvedValue([]),
    };
    readModelRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((e) => e),
      save: jest.fn((e) => Promise.resolve(e)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClaimProjectorService,
        {
          provide: getRepositoryToken(ClaimLifecycleEvent),
          useValue: eventRepo,
        },
        {
          provide: getRepositoryToken(ClaimReadModel),
          useValue: readModelRepo,
        },
      ],
    }).compile();

    service = moduleRef.get(ClaimProjectorService);
  });

  it('projects a SUBMITTED event into a Submitted read model', async () => {
    const state = await service.project(baseEvent());
    expect(state).toBe(ClaimState.Submitted);
    expect(readModelRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: 'claim-1',
        state: ClaimState.Submitted,
      }),
    );
  });

  it('applies a legal follow-up transition (Submitted -> UnderVerification)', async () => {
    readModelRepo.findOne
      .mockResolvedValueOnce(null) // no current
      .mockResolvedValueOnce(
        // subsequent projection finds the created model
        readModelRepo.create({
          claimId: 'claim-1',
          chainId: '10',
          state: ClaimState.Submitted,
          blockNumber: '100',
          eventTxHash: '0xabc',
          eventIndex: 1,
          stateChangedAt: new Date('2026-01-01T00:00:00Z'),
          settledAt: null,
        }),
      );

    await service.project(baseEvent());
    const state = await service.project(
      baseEvent({
        type: ClaimLifecycleEventType.UNDER_VERIFICATION,
        blockNumber: 101,
        eventIndex: 2,
        txHash: '0xdef',
      }),
    );
    expect(state).toBe(ClaimState.UnderVerification);
  });

  it('rejects an illegal transition (Submitted -> Disputed)', async () => {
    const state = await service.project(
      baseEvent({ type: ClaimLifecycleEventType.DISPUTED }),
    );
    expect(state).toBeNull();
  });

  it('is idempotent for a duplicate event', async () => {
    eventRepo.findOne.mockResolvedValueOnce({ id: 'existing' });
    const state = await service.project(baseEvent());
    expect(state).toBeNull();
    expect(readModelRepo.save).not.toHaveBeenCalled();
  });

  it('does not apply a stale (older) event after a newer one', async () => {
    readModelRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
      readModelRepo.create({
        claimId: 'claim-1',
        chainId: '10',
        state: ClaimState.Settled,
        blockNumber: '200',
        eventTxHash: '0xnew',
        eventIndex: 5,
        stateChangedAt: new Date('2026-02-01T00:00:00Z'),
        settledAt: new Date('2026-02-01T00:00:00Z'),
      }),
    );

    await service.project(baseEvent());
    // Try to apply an older SUBMITTED on a settled claim -> illegal -> null
    const state = await service.project(
      baseEvent({
        eventIndex: 3,
        blockNumber: 150,
        txHash: '0xold',
      }),
    );
    expect(state).toBeNull();
  });

  it('keeps settledAt null for non-settled transitions', async () => {
    readModelRepo.findOne
      .mockResolvedValueOnce(null) // first: no current model
      .mockResolvedValueOnce(
        readModelRepo.create({
          claimId: 'claim-x',
          chainId: '10',
          state: ClaimState.Submitted,
          blockNumber: '10',
          eventTxHash: '0xsub',
          eventIndex: 1,
          stateChangedAt: new Date('2026-01-01T00:00:00Z'),
          settledAt: null,
        }),
      );

    await service.project(
      baseEvent({
        claimId: 'claim-x',
        blockNumber: 10,
        eventIndex: 1,
        txHash: '0xsub',
      }),
    );
    await service.project(
      baseEvent({
        type: ClaimLifecycleEventType.UNDER_VERIFICATION,
        claimId: 'claim-x',
        blockNumber: 11,
        eventIndex: 2,
        txHash: '0xuv',
      }),
    );

    expect(readModelRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        settledAt: null,
        state: 'UNDER_VERIFICATION',
      }),
    );
  });

  it('reprojects a claim from stored event history', async () => {
    eventRepo.find.mockResolvedValue([
      {
        type: ClaimLifecycleEventType.SUBMITTED,
        blockNumber: '100',
        eventIndex: 1,
        txHash: '0x1',
        blockTimestamp: new Date('2026-01-01T00:00:00Z'),
      },
      {
        type: ClaimLifecycleEventType.UNDER_VERIFICATION,
        blockNumber: '110',
        eventIndex: 2,
        txHash: '0x2',
        blockTimestamp: new Date('2026-01-02T00:00:00Z'),
      },
      {
        type: ClaimLifecycleEventType.SETTLED,
        blockNumber: '120',
        eventIndex: 3,
        txHash: '0x3',
        blockTimestamp: new Date('2026-01-03T00:00:00Z'),
      },
    ]);
    const state = await service.reproject('claim-r', '10');
    expect(state).toBe(ClaimState.Settled);
  });
});
