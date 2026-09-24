import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EvidenceFlagService } from './evidence-flag.service';
import { EvidenceFlag } from './entities/evidence-flag.entity';
import { Evidence } from './entities/evidence.entity';
import { NotFoundException } from '@nestjs/common';

describe('EvidenceFlagService', () => {
  let service: EvidenceFlagService;
  let flagRepo: Repository<EvidenceFlag>;
  let evidenceRepo: Repository<Evidence>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvidenceFlagService,
        {
          provide: getRepositoryToken(EvidenceFlag),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(Evidence),
          useClass: Repository,
        },
      ],
    }).compile();

    service = module.get<EvidenceFlagService>(EvidenceFlagService);
    flagRepo = module.get<Repository<EvidenceFlag>>(getRepositoryToken(EvidenceFlag));
    evidenceRepo = module.get<Repository<Evidence>>(getRepositoryToken(Evidence));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createFlag', () => {
    const evidenceId = 'evidence-1';
    const reason = 'spam';
    const flaggedBy = 'user-1';

    it('should throw NotFoundException if evidence does not exist', async () => {
      jest.spyOn(evidenceRepo, 'findOneBy').mockResolvedValue(null);

      await expect(service.createFlag(evidenceId, reason)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should create a flag and not hide evidence if isModerator is false', async () => {
      const evidence = { id: evidenceId, isHidden: false } as Evidence;
      const flag = {
        id: 'flag-1',
        evidenceId,
        reason,
        flaggedBy,
        isModerator: false,
      } as any;

      jest.spyOn(evidenceRepo, 'findOneBy').mockResolvedValue(evidence);
      jest.spyOn(flagRepo, 'create').mockReturnValue(flag);
      jest.spyOn(flagRepo, 'save').mockResolvedValue(flag);
      const evidenceSaveSpy = jest.spyOn(evidenceRepo, 'save').mockResolvedValue(evidence);

      const result = await service.createFlag(evidenceId, reason, flaggedBy, false);

      expect(result).toEqual(flag);
      expect(evidenceSaveSpy).not.toHaveBeenCalled();
      expect(flagRepo.create).toHaveBeenCalledWith({
        evidenceId,
        reason,
        flaggedBy,
      });
      expect(result.isModerator).toBe(false);
    });

    it('should create a flag and hide evidence if isModerator is true', async () => {
      const evidence = { id: evidenceId, isHidden: false } as Evidence;
      const flag = {
        id: 'flag-1',
        evidenceId,
        reason,
        flaggedBy,
        isModerator: true,
      } as any;

      jest.spyOn(evidenceRepo, 'findOneBy').mockResolvedValue(evidence);
      jest.spyOn(flagRepo, 'create').mockReturnValue(flag);
      jest.spyOn(flagRepo, 'save').mockResolvedValue(flag);
      const evidenceSaveSpy = jest.spyOn(evidenceRepo, 'save').mockResolvedValue({
        ...evidence,
        isHidden: true,
      } as Evidence);

      const result = await service.createFlag(evidenceId, reason, flaggedBy, true);

      expect(result).toEqual(flag);
      expect(evidenceSaveSpy).toHaveBeenCalledWith(expect.objectContaining({ isHidden: true }));
      expect(flagRepo.create).toHaveBeenCalledWith({
        evidenceId,
        reason,
        flaggedBy,
      });
      expect(result.isModerator).toBe(true);
    });
  });

  describe('getFlagsForEvidence', () => {
    it('should return flags for an evidence', async () => {
      const evidenceId = 'evidence-1';
      const flags = [{ id: 'flag-1', evidenceId }] as EvidenceFlag[];

      jest.spyOn(flagRepo, 'find').mockResolvedValue(flags);

      const result = await service.getFlagsForEvidence(evidenceId);

      expect(result).toEqual(flags);
      expect(flagRepo.find).toHaveBeenCalledWith({
        where: { evidenceId },
        order: { createdAt: 'ASC' },
      });
    });
  });
});
