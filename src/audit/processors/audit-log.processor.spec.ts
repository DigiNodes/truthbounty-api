import { AuditLogProcessor } from './audit-log.processor';
import { AuditTrailService } from '../services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../entities/audit-log.entity';

describe('AuditLogProcessor', () => {
  let processor: AuditLogProcessor;
  let auditTrailService: jest.Mocked<Pick<AuditTrailService, 'persistChainedRecord'>>;

  beforeEach(() => {
    auditTrailService = {
      persistChainedRecord: jest.fn(),
    };
    processor = new AuditLogProcessor(auditTrailService as unknown as AuditTrailService);
  });

  it('delegates to the atomic chained write path used by log()/logBatch()', async () => {
    (auditTrailService.persistChainedRecord as jest.Mock).mockResolvedValue({ id: 'audit-1' });

    const job = {
      id: 'job-1',
      data: {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
        ipAddress: '203.0.113.45',
      },
    } as any;

    await processor.process(job);

    expect(auditTrailService.persistChainedRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
        // IP is masked before being handed to the shared write path, same
        // as the synchronous log() path.
        ipAddress: '203.0.113.0',
      }),
    );
  });

  it('rethrows on failure so BullMQ retries the job, instead of swallowing it', async () => {
    (auditTrailService.persistChainedRecord as jest.Mock).mockRejectedValue(new Error('DB down'));

    const job = {
      id: 'job-2',
      data: {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'claim-1',
      },
    } as any;

    await expect(processor.process(job)).rejects.toThrow('DB down');
  });
});
