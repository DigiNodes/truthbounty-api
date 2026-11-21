import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IpfsService } from '../../ipfs/ipfs.service';
import {
  CANONICAL_CLAIM_IDENTITY,
  EvidenceUploadPreparationService,
} from './evidence-upload-preparation.service';

describe('EvidenceUploadPreparationService (PREWAVE-BE-132)', () => {
  let service: EvidenceUploadPreparationService;
  let identity: { assertCanonicalClaim: jest.Mock };
  let ipfs: { uploadBuffer: jest.Mock; getGatewayUrl: jest.Mock };

  beforeEach(async () => {
    identity = { assertCanonicalClaim: jest.fn().mockResolvedValue(undefined) };
    ipfs = {
      uploadBuffer: jest
        .fn()
        .mockResolvedValue({ cid: 'bafy-content-1', size: 13 }),
      getGatewayUrl: jest
        .fn()
        .mockReturnValue('https://gateway.example/ipfs/bafy-content-1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceUploadPreparationService,
        { provide: CANONICAL_CLAIM_IDENTITY, useValue: identity },
        { provide: IpfsService, useValue: ipfs },
      ],
    }).compile();

    service = module.get(EvidenceUploadPreparationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('prepares IPFS content without claiming on-chain registration', async () => {
    const result = await service.prepare('claim-1', {
      content: 'evidence body',
    });

    expect(identity.assertCanonicalClaim).toHaveBeenCalledWith('claim-1');
    expect(ipfs.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        claimId: 'claim-1',
        cid: 'bafy-content-1',
        status: 'IPFS_CONTENT_PREPARED',
        onChainRegistered: false,
        evidenceRegistered: false,
        canonical: false,
      }),
    );
    expect(result.attestation).toMatch(/No claim or evidence was registered/i);
    expect(result.gatewayUrl).toBe(
      'https://gateway.example/ipfs/bafy-content-1',
    );
  });

  it('fails closed for unknown or not-yet-projected claim ids', async () => {
    identity.assertCanonicalClaim.mockRejectedValue(
      new NotFoundException('claim not projected'),
    );

    await expect(
      service.prepare('missing-claim', { content: 'body' }),
    ).rejects.toThrow(NotFoundException);
    expect(ipfs.uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects malformed claim ids before any work', async () => {
    await expect(
      service.prepare('bad id with spaces', { content: 'body' }),
    ).rejects.toThrow(/Invalid canonical claim id/);
    expect(identity.assertCanonicalClaim).not.toHaveBeenCalled();
    expect(ipfs.uploadBuffer).not.toHaveBeenCalled();
  });

  it('does not store or forward content containing secrets', async () => {
    await expect(
      service.prepare('claim-1', {
        content: 'private key: 0x' + 'a'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(ipfs.uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized content', async () => {
    await expect(service.prepare('claim-1', { content: '' })).rejects.toThrow(
      /non-empty/,
    );
    await expect(
      service.prepare('claim-1', { content: 'x'.repeat(10 * 1024 * 1024 + 1) }),
    ).rejects.toThrow(/between 1 and/);
    expect(ipfs.uploadBuffer).not.toHaveBeenCalled();
  });

  it('is deterministic for repeated uploads of the same content', async () => {
    const first = await service.prepare('claim-1', { content: 'same body' });
    const second = await service.prepare('claim-1', { content: 'same body' });

    expect(second.preparationId).toBe(first.preparationId);
    expect(second.cid).toBe(first.cid);
    expect(second.onChainRegistered).toBe(false);
  });

  it('supports base64 content and rejects an unsupported encoding', async () => {
    const base64 = Buffer.from('binary content').toString('base64');
    await service.prepare('claim-1', { content: base64, encoding: 'base64' });
    expect(ipfs.uploadBuffer).toHaveBeenCalledWith(
      Buffer.from('binary content'),
      undefined,
    );

    await expect(
      service.prepare('claim-1', { content: base64, encoding: 'hex' as never }),
    ).rejects.toThrow(/utf8 or base64/);
  });

  it('fails closed when the provider returns no CID', async () => {
    ipfs.uploadBuffer.mockResolvedValue({ cid: '', size: 0 });

    await expect(
      service.prepare('claim-1', { content: 'body' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('never exposes protocol mutation fields in the response', async () => {
    const result = await service.prepare('claim-1', { content: 'body' });
    expect(result).not.toHaveProperty('finalized');
    expect(result).not.toHaveProperty('resolvedVerdict');
    expect(result).not.toHaveProperty('version');
    expect(result).not.toHaveProperty('transactionHash');
  });
});
