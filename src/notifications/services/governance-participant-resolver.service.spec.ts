import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { GovernanceParticipantResolver } from './governance-participant-resolver.service';
import { Vote } from '../../governance/entities/proposal.entity';

describe('GovernanceParticipantResolver', () => {
  let service: GovernanceParticipantResolver;
  let voteRepository: Repository<Vote>;
  let mockQueryBuilder: jest.Mocked<SelectQueryBuilder<Vote>>;

  beforeEach(async () => {
    mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(),
    } as any;

    const mockVoteRepository = {
      createQueryBuilder: jest.fn(() => mockQueryBuilder),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceParticipantResolver,
        {
          provide: getRepositoryToken(Vote),
          useValue: mockVoteRepository,
        },
      ],
    }).compile();

    service = module.get<GovernanceParticipantResolver>(GovernanceParticipantResolver);
    voteRepository = module.get<Repository<Vote>>(getRepositoryToken(Vote));
  });

  describe('getProposalCreatedParticipants', () => {
    it('should return active voters from last 30 days', async () => {
      const mockVoters = [
        { vote_voter: 'voter-1' },
        { vote_voter: 'voter-2' },
        { vote_voter: 'voter-3' },
      ];

      mockQueryBuilder.getRawMany.mockResolvedValue(mockVoters);

      const result = await service.getProposalCreatedParticipants('proposal-1');

      expect(result).toEqual(['voter-1', 'voter-2', 'voter-3']);
      expect(voteRepository.createQueryBuilder).toHaveBeenCalled();
      expect(mockQueryBuilder.select).toHaveBeenCalledWith('DISTINCT vote.voter');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'vote.createdAt >= :cutoff',
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
    });

    it('should deduplicate voters', async () => {
      const mockVoters = [
        { vote_voter: 'voter-1' },
        { vote_voter: 'voter-1' }, // Duplicate
        { vote_voter: 'voter-2' },
      ];

      mockQueryBuilder.getRawMany.mockResolvedValue(mockVoters);

      const result = await service.getProposalCreatedParticipants('proposal-1');

      expect(result).toEqual(['voter-1', 'voter-2']);
      expect(result.length).toBe(2);
    });

    it('should enforce bounded fan-out (max 1000 participants)', async () => {
      // Create 1500 voters
      const mockVoters = Array.from({ length: 1500 }, (_, i) => ({
        vote_voter: `voter-${i}`,
      }));

      mockQueryBuilder.getRawMany.mockResolvedValue(mockVoters);

      const result = await service.getProposalCreatedParticipants('proposal-1');

      expect(result.length).toBe(1000); // Should be truncated to max
    });

    it('should use custom activity window when provided', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getProposalCreatedParticipants('proposal-1', {
        activityWindowDays: 60, // Custom 60-day window
        maxParticipants: 1000,
        requireActiveVoting: true,
      });

      // Verify that where clause was called with appropriate cutoff
      expect(mockQueryBuilder.where).toHaveBeenCalled();
      const whereCall = mockQueryBuilder.where.mock.calls[0];
      const cutoffDate = whereCall[1].cutoff;
      
      // Calculate expected cutoff (60 days ago)
      const expectedCutoff = new Date();
      expectedCutoff.setDate(expectedCutoff.getDate() - 60);

      // Verify cutoff is approximately 60 days ago (within 1 second tolerance)
      expect(Math.abs(cutoffDate.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
    });

    it('should handle database errors gracefully', async () => {
      mockQueryBuilder.getRawMany.mockRejectedValue(new Error('Database error'));

      const result = await service.getProposalCreatedParticipants('proposal-1');

      // Fail-closed: return empty array on error
      expect(result).toEqual([]);
    });

    it('should return empty array when no active voters', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.getProposalCreatedParticipants('proposal-1');

      expect(result).toEqual([]);
    });
  });

  describe('getVoteReminderParticipants', () => {
    it('should return active voters who have not voted on the proposal', async () => {
      // Mock active voters
      const mockActiveVoters = [
        { vote_voter: 'voter-1' },
        { vote_voter: 'voter-2' },
        { vote_voter: 'voter-3' },
      ];

      // Mock existing votes on this proposal
      const mockExistingVotes = [
        { voter: 'voter-2' }, // Already voted
      ];

      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);
      (voteRepository.find as jest.Mock).mockResolvedValue(mockExistingVotes);

      const result = await service.getVoteReminderParticipants('proposal-1');

      // Should exclude voter-2 who already voted
      expect(result).toEqual(['voter-1', 'voter-3']);
      expect(result).not.toContain('voter-2');
    });

    it('should return empty array when all active voters have already voted', async () => {
      const mockActiveVoters = [
        { vote_voter: 'voter-1' },
        { vote_voter: 'voter-2' },
      ];

      const mockExistingVotes = [
        { voter: 'voter-1' },
        { voter: 'voter-2' },
      ];

      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);
      (voteRepository.find as jest.Mock).mockResolvedValue(mockExistingVotes);

      const result = await service.getVoteReminderParticipants('proposal-1');

      expect(result).toEqual([]);
    });

    it('should enforce bounded fan-out', async () => {
      const mockActiveVoters = Array.from({ length: 1500 }, (_, i) => ({
        vote_voter: `voter-${i}`,
      }));

      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);
      (voteRepository.find as jest.Mock).mockResolvedValue([]);

      const result = await service.getVoteReminderParticipants('proposal-1');

      expect(result.length).toBe(1000);
    });

    it('should handle database errors gracefully', async () => {
      mockQueryBuilder.getRawMany.mockRejectedValue(new Error('Database error'));

      const result = await service.getVoteReminderParticipants('proposal-1');

      expect(result).toEqual([]);
    });
  });

  describe('getVoteClosedParticipants', () => {
    it('should return proposal voters plus active governance participants', async () => {
      // Mock proposal voters
      const mockProposalVotes = [
        { voter: 'voter-1' },
        { voter: 'voter-2' },
      ];

      // Mock active voters
      const mockActiveVoters = [
        { vote_voter: 'voter-2' }, // Already in proposal voters (will be deduped)
        { vote_voter: 'voter-3' },
        { vote_voter: 'voter-4' },
      ];

      (voteRepository.find as jest.Mock).mockResolvedValue(mockProposalVotes);
      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);

      const result = await service.getVoteClosedParticipants('proposal-1');

      // Should include all unique voters
      expect(result).toEqual(expect.arrayContaining(['voter-1', 'voter-2', 'voter-3', 'voter-4']));
      expect(result.length).toBe(4); // Deduplicated
    });

    it('should deduplicate between proposal voters and active voters', async () => {
      const mockProposalVotes = [
        { voter: 'voter-1' },
        { voter: 'voter-2' },
      ];

      const mockActiveVoters = [
        { vote_voter: 'voter-1' }, // Duplicate
        { vote_voter: 'voter-2' }, // Duplicate
      ];

      (voteRepository.find as jest.Mock).mockResolvedValue(mockProposalVotes);
      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);

      const result = await service.getVoteClosedParticipants('proposal-1');

      expect(result).toEqual(['voter-1', 'voter-2']);
      expect(result.length).toBe(2);
    });

    it('should enforce bounded fan-out', async () => {
      const mockProposalVotes = Array.from({ length: 500 }, (_, i) => ({
        voter: `proposal-voter-${i}`,
      }));

      const mockActiveVoters = Array.from({ length: 1000 }, (_, i) => ({
        vote_voter: `active-voter-${i}`,
      }));

      (voteRepository.find as jest.Mock).mockResolvedValue(mockProposalVotes);
      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);

      const result = await service.getVoteClosedParticipants('proposal-1');

      expect(result.length).toBe(1000); // Max participants
    });

    it('should handle database errors gracefully', async () => {
      (voteRepository.find as jest.Mock).mockRejectedValue(new Error('Database error'));

      const result = await service.getVoteClosedParticipants('proposal-1');

      expect(result).toEqual([]);
    });
  });

  describe('getProposalExecutedParticipants', () => {
    it('should return same participants as vote-closed event', async () => {
      const mockProposalVotes = [
        { voter: 'voter-1' },
        { voter: 'voter-2' },
      ];

      const mockActiveVoters = [
        { vote_voter: 'voter-3' },
      ];

      (voteRepository.find as jest.Mock).mockResolvedValue(mockProposalVotes);
      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);

      const result = await service.getProposalExecutedParticipants('proposal-1');

      expect(result).toEqual(expect.arrayContaining(['voter-1', 'voter-2', 'voter-3']));
    });
  });

  describe('security and no broadcast to all users', () => {
    it('should not return all users - only active participants', async () => {
      // Simulate scenario where there are many inactive users
      // but only a few active voters
      const mockActiveVoters = [
        { vote_voter: 'active-1' },
        { vote_voter: 'active-2' },
      ];

      mockQueryBuilder.getRawMany.mockResolvedValue(mockActiveVoters);

      const result = await service.getProposalCreatedParticipants('proposal-1');

      // Should only return active voters, not all users
      expect(result).toEqual(['active-1', 'active-2']);
      expect(result.length).toBe(2);
    });

    it('should respect activity window constraint', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getProposalCreatedParticipants('proposal-1');

      // Verify that where clause includes activity cutoff
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'vote.createdAt >= :cutoff',
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
    });

    it('should query only voters, not all users', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getProposalCreatedParticipants('proposal-1');

      // Verify that query builder was called on Vote repository
      expect(voteRepository.createQueryBuilder).toHaveBeenCalled();
      expect(mockQueryBuilder.select).toHaveBeenCalledWith('DISTINCT vote.voter');
    });
  });

  describe('stable results during participant changes', () => {
    it('should return consistent results when called multiple times', async () => {
      const mockVoters = [
        { vote_voter: 'voter-1' },
        { vote_voter: 'voter-2' },
      ];

      mockQueryBuilder.getRawMany.mockResolvedValue(mockVoters);

      const result1 = await service.getProposalCreatedParticipants('proposal-1');
      const result2 = await service.getProposalCreatedParticipants('proposal-1');

      expect(result1).toEqual(result2);
    });
  });

  describe('getActiveVoters (private method via public methods)', () => {
    it('should correctly calculate activity cutoff date', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      await service.getProposalCreatedParticipants('proposal-1', {
        activityWindowDays: 30,
        maxParticipants: 1000,
        requireActiveVoting: true,
      });

      const whereCall = mockQueryBuilder.where.mock.calls[0];
      const cutoffDate = whereCall[1].cutoff;

      // Verify cutoff is approximately 30 days ago
      const now = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(now.getDate() - 30);

      const timeDiff = Math.abs(cutoffDate.getTime() - thirtyDaysAgo.getTime());
      expect(timeDiff).toBeLessThan(1000); // Within 1 second
    });
  });
});
