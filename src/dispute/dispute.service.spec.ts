jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { DisputeService } from './dispute.service';
import { DisputeJournalStore } from './dispute-journal.store';
import { DisputeProjectionService } from './dispute-projection.service';

describe('dispute authority boundary', () => {
  const principal = { address: `0x${'a'.repeat(40)}` };
  const scope = {
    chainId: 10,
    releaseId: 'r',
    contractAddress: principal.address,
  };
  const row = {
    id: 'workflow-1',
    claimId: 'claim',
    metadata: {},
    reviewStatus: 'REQUESTED',
  };
  let store: { create: jest.Mock; review: jest.Mock; workflows: jest.Mock };
  let service: DisputeService;
  beforeEach(() => {
    store = {
      create: jest.fn().mockResolvedValue(row),
      review: jest
        .fn()
        .mockResolvedValue({ ...row, reviewStatus: 'DISMISSED' }),
      workflows: jest.fn().mockResolvedValue([row]),
    };
    const projection = {
      release: () => scope,
      snapshot: jest.fn().mockResolvedValue({ items: [] }),
    };
    service = new DisputeService(
      store as unknown as DisputeJournalStore,
      projection as unknown as DisputeProjectionService,
    );
  });

  it.each([
    'initiatorId',
    'trigger',
    'originalConfidence',
    'outcome',
    'finalConfidence',
    'status',
  ])('rejects client authority field %s', async (key) => {
    await expect(
      service.createDispute({ claimId: 'claim', [key]: 'injected' }, principal),
    ).rejects.toThrow('Only claimId');
    expect(store.create).not.toHaveBeenCalled();
  });
  it('requires a principal and persists the verified wallet', async () => {
    await expect(service.createDispute({ claimId: 'claim' })).rejects.toThrow();
    const result = await service.createDispute(
      { claimId: 'claim', metadata: { outcome: 'UNTRUSTED' } },
      principal,
    );
    expect(store.create).toHaveBeenCalledWith(
      scope,
      'claim',
      principal.address,
      { outcome: 'UNTRUSTED' },
    );
    expect(result.workflow.authority).toBe('non_authoritative_workflow');
    expect(result).not.toHaveProperty('outcome');
  });
  it('triage only updates workflow and cannot set protocol terminal status', async () => {
    const result = await service.review(
      'workflow-1',
      principal,
      'DISMISSED',
      'spam',
    );
    expect(store.review).toHaveBeenCalledWith(
      scope,
      'workflow-1',
      principal.address,
      'DISMISSED',
      'spam',
    );
    expect(result.workflow).not.toHaveProperty('outcome');
    for (const status of ['RESOLVED', 'REJECTED', 'SETTLED', 'EXPIRED']) {
      await expect(
        service.review('workflow-1', principal, status),
      ).rejects.toThrow();
    }
  });
  it('retires every legacy terminal writer, including internal expiry', () => {
    expect(() => service.resolveDispute({ outcome: 'CONFIRMED' })).toThrow();
    expect(() => service.rejectDispute({ reason: 'spam' })).toThrow();
    expect(() => service.expireDispute('workflow-1')).toThrow();
    expect(store.review).not.toHaveBeenCalled();
  });
  it('keeps metadata separate and does not expose old local terminal rows', async () => {
    const result = await service.getDisputeByClaimId('claim');
    expect(result.items).toEqual([]);
    expect(result.workflows[0].authority).toBe('non_authoritative_workflow');
  });
});
