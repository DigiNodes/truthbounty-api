import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { ClaimStakeholderResolver } from './claim-stakeholder-resolver.service';
import { Claim } from '../../claims/entities/claim.entity';
import { Evidence } from '../../claims/entities/evidence.entity';

describe('ClaimStakeholderResolver', () => {
  let service: ClaimStakeholderResolver;
  let claimRepository: Repository<Claim>;
  let evidenceRepository: Repository<Evidence>;
  let mockManager: jest.Mocked<EntityManager>;

  beforeEach(async () => {
    mockManager = {
      findOne: jest.fn(),
      find: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimStakeholderResolver,
        {
          provide: getRepositoryToken(Claim),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Evidence),
          useValue: {
            find: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ClaimStakeholderResolver>(ClaimStakeholderResolver);
    claimRepository = module.get<Repository<Claim>>(getRepositoryToken(Claim));
    evidenceRepository = module.get<Repository<Evidence>>(getRepositoryToken(Evidence));
  });

  describe('resolveStakeholders', () => {
    it('should resolve creator from claim metadata', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue([]);

      const result = await service.resolveStakeholders('claim-1', mockManager);

      expect(result.creator).toBe('user-1');
      expect(mockManager.findOne).toHaveBeenCalledWith(Claim, {
        where: { id: 'claim-1' },
        select: ['id', 'metadata'],
      });
    });

    it('should resolve verifiers from evidence submissions', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
        { id: 'evidence-2', metadata: { verifierId: 'verifier-2' } },
        { id: 'evidence-3', metadata: { userId: 'verifier-3' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.resolveStakeholders('claim-1', mockManager);

      expect(result.verifiers).toEqual(['verifier-1', 'verifier-2', 'verifier-3']);
      expect(mockManager.find).toHaveBeenCalledWith(Evidence, {
        where: { claimId: 'claim-1' },
        select: ['id', 'metadata'],
      });
    });

    it('should handle missing claim gracefully', async () => {
      mockManager.findOne.mockResolvedValue(null);

      const result = await service.resolveStakeholders('nonexistent', mockManager);

      expect(result).toEqual({
        creator: null,
        verifiers: [],
        commenters: [],
        watchers: [],
        assignedVerifiers: [],
      });
    });

    it('should handle claim with no metadata', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: null,
      };

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue([]);

      const result = await service.resolveStakeholders('claim-1', mockManager);

      expect(result.creator).toBeNull();
      expect(result.verifiers).toEqual([]);
    });

    it('should filter out null/undefined verifier IDs', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
        { id: 'evidence-2', metadata: {} }, // No verifier ID
        { id: 'evidence-3', metadata: { submittedBy: null } }, // Null ID
        { id: 'evidence-4', metadata: { submittedBy: 'verifier-2' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.resolveStakeholders('claim-1', mockManager);

      expect(result.verifiers).toEqual(['verifier-1', 'verifier-2']);
    });

    it('should handle database errors gracefully', async () => {
      mockManager.findOne.mockRejectedValue(new Error('Database error'));

      const result = await service.resolveStakeholders('claim-1', mockManager);

      // Fail-closed: return empty stakeholders on error
      expect(result).toEqual({
        creator: null,
        verifiers: [],
        commenters: [],
        watchers: [],
        assignedVerifiers: [],
      });
    });
  });

  describe('getClaimCreatedRecipients', () => {
    it('should return only the creator for claim-created events', async () => {
      const result = await service.getClaimCreatedRecipients(
        'claim-1',
        'creator-1',
        mockManager,
      );

      expect(result).toEqual(['creator-1']);
    });
  });

  describe('getClaimUpdatedRecipients', () => {
    it('should return all stakeholders except the actor', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
        { id: 'evidence-2', metadata: { submittedBy: 'verifier-2' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.getClaimUpdatedRecipients(
        'claim-1',
        'user-1', // Actor is the creator
        mockManager,
      );

      // Should include verifiers but exclude creator (actor)
      expect(result).toEqual(expect.arrayContaining(['verifier-1', 'verifier-2']));
      expect(result).not.toContain('user-1'); // Actor excluded
    });

    it('should deduplicate recipients', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
        { id: 'evidence-2', metadata: { submittedBy: 'verifier-1' } }, // Duplicate
        { id: 'evidence-3', metadata: { submittedBy: 'verifier-2' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.getClaimUpdatedRecipients(
        'claim-1',
        'actor-1',
        mockManager,
      );

      // Should deduplicate verifier-1
      expect(result.filter(id => id === 'verifier-1').length).toBe(1);
      expect(result).toEqual(expect.arrayContaining(['user-1', 'verifier-1', 'verifier-2']));
    });

    it('should return empty array when no stakeholders found', async () => {
      mockManager.findOne.mockResolvedValue(null);

      const result = await service.getClaimUpdatedRecipients(
        'nonexistent',
        'actor-1',
        mockManager,
      );

      expect(result).toEqual([]);
    });
  });

  describe('getClaimResolvedRecipients', () => {
    it('should return all stakeholders including creator', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
        { id: 'evidence-2', metadata: { submittedBy: 'verifier-2' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.getClaimResolvedRecipients('claim-1', mockManager);

      expect(result).toEqual(expect.arrayContaining(['user-1', 'verifier-1', 'verifier-2']));
      expect(result.length).toBe(3);
    });

    it('should deduplicate recipients', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'user-1' } }, // Same as creator
        { id: 'evidence-2', metadata: { submittedBy: 'verifier-1' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.getClaimResolvedRecipients('claim-1', mockManager);

      // Should deduplicate user-1
      expect(result.filter(id => id === 'user-1').length).toBe(1);
      expect(result).toEqual(expect.arrayContaining(['user-1', 'verifier-1']));
    });
  });

  describe('getClaimArchivedRecipients', () => {
    it('should return same recipients as resolved event', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue(mockEvidences as any);

      const result = await service.getClaimArchivedRecipients('claim-1', mockManager);

      expect(result).toEqual(expect.arrayContaining(['user-1', 'verifier-1']));
    });
  });

  describe('security and isolation', () => {
    it('should not expose cross-claim data', async () => {
      const mockClaim1 = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      const mockEvidences1 = [
        { id: 'evidence-1', metadata: { submittedBy: 'verifier-1' } },
      ];

      mockManager.findOne.mockResolvedValue(mockClaim1 as any);
      mockManager.find.mockResolvedValue(mockEvidences1 as any);

      const result1 = await service.resolveStakeholders('claim-1', mockManager);

      // Verify that query was scoped to claim-1
      expect(mockManager.find).toHaveBeenCalledWith(Evidence, {
        where: { claimId: 'claim-1' },
        select: ['id', 'metadata'],
      });

      // Result should only contain stakeholders for claim-1
      expect(result1.verifiers).toEqual(['verifier-1']);
    });

    it('should use transaction manager for consistency', async () => {
      const mockClaim = {
        id: 'claim-1',
        metadata: { creatorId: 'user-1' },
      };

      mockManager.findOne.mockResolvedValue(mockClaim as any);
      mockManager.find.mockResolvedValue([]);

      await service.resolveStakeholders('claim-1', mockManager);

      // Verify that the provided manager was used (not repository)
      expect(mockManager.findOne).toHaveBeenCalled();
      expect(mockManager.find).toHaveBeenCalled();
    });
  });
});
