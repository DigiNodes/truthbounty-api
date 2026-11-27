import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EvidenceController } from './evidence.controller';
import { EvidenceFlagService } from './evidence-flag.service';

describe('EvidenceController', () => {
  let controller: EvidenceController;
  let flagService: {
    createFlag: jest.Mock;
    getFlagsForEvidence: jest.Mock;
  };

  beforeEach(async () => {
    flagService = {
      createFlag: jest.fn(),
      getFlagsForEvidence: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EvidenceController],
      providers: [{ provide: EvidenceFlagService, useValue: flagService }],
    }).compile();

    controller = module.get(EvidenceController);
  });

  it('returns 410 for all legacy evidence reads without querying legacy services', async () => {
    const calls = [
      () => controller.listEvidence({ page: 1, limit: 20 }),
      () => controller.getEvidence('legacy-evidence'),
      () =>
        controller.listVersions('legacy-evidence', { page: 1, limit: 20 }),
      () => controller.getDigest('legacy-evidence', {}),
      () => controller.getGateway('legacy-evidence', {}),
      () => controller.getStatus('legacy-evidence'),
    ];

    for (const call of calls) {
      const result = call();
      await expect(result).rejects.toMatchObject({
        status: 410,
        response: expect.objectContaining({
          code: 'CANONICAL_CHAIN_STATE_REQUIRED',
        }),
      });
    }

    expect(flagService.createFlag).not.toHaveBeenCalled();
    expect(flagService.getFlagsForEvidence).not.toHaveBeenCalled();
  });

  it('keeps moderation flagging separate from evidence registration', async () => {
    await expect(
      controller.flagEvidence('evidence-id', { reason: 'spam' }),
    ).rejects.toThrow(BadRequestException);

    flagService.createFlag.mockResolvedValue({ id: 'flag-id' });
    await expect(
      controller.flagEvidence('evidence-id', { reason: 'spam' }),
    ).resolves.toEqual({ id: 'flag-id' });
    expect(flagService.createFlag).toHaveBeenCalledWith(
      'evidence-id',
      'spam',
      undefined,
    );
  });

  it('keeps evidence flag listing admin-only', async () => {
    await expect(controller.getFlags('evidence-id')).rejects.toThrow(
      ForbiddenException,
    );
  });
});
