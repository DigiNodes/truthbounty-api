import { EvidenceService } from './evidence.service';

describe('EvidenceService legacy protocol boundary', () => {
  const service = new EvidenceService();

  it('rejects registration and replacement operations', async () => {
    await expect(
      service.createEvidence('claim-id', 'cid'),
    ).rejects.toMatchObject({ status: 410 });

    await expect(
      service.addEvidenceVersion('evidence-id', 'replacement-cid'),
    ).rejects.toMatchObject({ status: 410 });
  });

  it('rejects legacy reads so TypeORM rows cannot appear canonical', async () => {
    const calls = [
      () => service.getEvidence('legacy-evidence'),
      () => service.getEvidenceOrFail('legacy-evidence'),
      () => service.getEvidenceForClaim('claim-id'),
      () => service.getLatestEvidenceForClaim('claim-id'),
      () => service.listEvidence({ page: 1, limit: 20 }),
      () =>
        service.listEvidenceVersions('legacy-evidence', { page: 1, limit: 20 }),
      () => service.getContentDigest('legacy-evidence'),
      () => service.getSafeGateway('legacy-evidence'),
      () => service.getAvailabilityStatus('legacy-evidence'),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ status: 410 });
    }
  });
});
