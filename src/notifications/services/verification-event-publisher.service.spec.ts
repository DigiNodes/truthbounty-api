import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { VerificationEventPublisher } from './verification-event-publisher.service';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { CanonicalEvent } from '../../v2/events/entities/canonical-event.entity';
import { ProjectVerificationRound } from '../../v2/verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../../v2/verification/entities/project-participant-position.entity';
import { User, UserRole } from '../../entities/user.entity';
import { EventType } from '../enums/event-type.enum';

describe('VerificationEventPublisher', () => {
  let service: VerificationEventPublisher;
  let notificationPublisher: jest.Mocked<NotificationEventPublisher>;
  let canonicalEventRepo: jest.Mocked<Repository<CanonicalEvent>>;
  let verificationRoundRepo: jest.Mocked<Repository<ProjectVerificationRound>>;
  let participantPositionRepo: jest.Mocked<Repository<ProjectParticipantPosition>>;
  let userRepo: jest.Mocked<Repository<User>>;
  let mockEntityManager: jest.Mocked<EntityManager>;

  const CLAIM_ID = '0x' + '11'.repeat(32);
  const VERIFIER_ADDRESS = '0x' + '22'.repeat(20);
  const CREATOR_ADDRESS = '0x' + '33'.repeat(20);
  const OTHER_VERIFIER_ADDRESS = '0x' + '44'.repeat(20);
  const CONTESTER_ADDRESS = '0x' + '55'.repeat(20);
  const ROUND_ID = '0x' + 'aa'.repeat(32);

  const mockCreatorUser: User = {
    id: 'creator-uuid',
    walletAddress: CREATOR_ADDRESS.toLowerCase(),
    role: UserRole.USER,
    reputation: 0,
    worldcoinVerified: false,
    worldcoinVerifiedAt: null,
    wallets: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockVerifierUser: User = {
    id: 'verifier-uuid',
    walletAddress: VERIFIER_ADDRESS.toLowerCase(),
    role: UserRole.USER,
    reputation: 0,
    worldcoinVerified: false,
    worldcoinVerifiedAt: null,
    wallets: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockOtherVerifierUser: User = {
    id: 'other-verifier-uuid',
    walletAddress: OTHER_VERIFIER_ADDRESS.toLowerCase(),
    role: UserRole.USER,
    reputation: 0,
    worldcoinVerified: false,
    worldcoinVerifiedAt: null,
    wallets: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockContesterUser: User = {
    id: 'contester-uuid',
    walletAddress: CONTESTER_ADDRESS.toLowerCase(),
    role: UserRole.USER,
    reputation: 0,
    worldcoinVerified: false,
    worldcoinVerifiedAt: null,
    wallets: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockModeratorUser: User = {
    id: 'moderator-uuid',
    walletAddress: '0x' + '66'.repeat(20),
    role: UserRole.MODERATOR,
    reputation: 0,
    worldcoinVerified: false,
    worldcoinVerifiedAt: null,
    wallets: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockAdminUser: User = {
    id: 'admin-uuid',
    walletAddress: '0x' + '77'.repeat(20),
    role: UserRole.ADMIN,
    reputation: 0,
    worldcoinVerified: false,
    worldcoinVerifiedAt: null,
    wallets: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockCanonicalEventRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const mockVerificationRoundRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const mockParticipantPositionRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const mockUserRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn(),
      })),
    };

    const mockNotificationPublisher = {
      publishEvent: jest.fn().mockResolvedValue({
        id: 'outbox-id',
        status: 'PENDING',
        idempotencyKey: 'test-key',
      }),
    };

    mockEntityManager = {
      getRepository: jest.fn((entity) => {
        if (entity === CanonicalEvent) return mockCanonicalEventRepo;
        if (entity === ProjectVerificationRound) return mockVerificationRoundRepo;
        if (entity === ProjectParticipantPosition) return mockParticipantPositionRepo;
        if (entity === User) return mockUserRepo;
        return null;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationEventPublisher,
        {
          provide: NotificationEventPublisher,
          useValue: mockNotificationPublisher,
        },
        {
          provide: getRepositoryToken(CanonicalEvent),
          useValue: mockCanonicalEventRepo,
        },
        {
          provide: getRepositoryToken(ProjectVerificationRound),
          useValue: mockVerificationRoundRepo,
        },
        {
          provide: getRepositoryToken(ProjectParticipantPosition),
          useValue: mockParticipantPositionRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepo,
        },
      ],
    }).compile();

    service = module.get<VerificationEventPublisher>(VerificationEventPublisher);
    notificationPublisher = module.get(NotificationEventPublisher) as jest.Mocked<NotificationEventPublisher>;
    canonicalEventRepo = module.get(getRepositoryToken(CanonicalEvent)) as jest.Mocked<Repository<CanonicalEvent>>;
    verificationRoundRepo = module.get(getRepositoryToken(ProjectVerificationRound)) as jest.Mocked<Repository<ProjectVerificationRound>>;
    participantPositionRepo = module.get(getRepositoryToken(ProjectParticipantPosition)) as jest.Mocked<Repository<ProjectParticipantPosition>>;
    userRepo = module.get(getRepositoryToken(User)) as jest.Mocked<Repository<User>>;

    jest.clearAllMocks();
  });

  describe('publishVerificationCompleted', () => {
    describe('getVerificationRecipients - Claim Creator Resolution', () => {
      it('should include claim creator from EvidenceRegistered event', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: EventType.VERIFICATION_COMPLETED,
            recipientIds: expect.arrayContaining(['creator-uuid']),
          }),
          mockEntityManager,
        );
      });

      it('should handle missing claim creator gracefully', async () => {
        canonicalEventRepo.findOne.mockResolvedValueOnce(null);
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        userRepo.findOne.mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        // Should still publish with empty recipients (will be skipped in publishEvent)
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });

      it('should handle claim creator not found in users table', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(null) // claim creator not found
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        // Should not publish if no recipients resolved
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });
    });

    describe('getVerificationRecipients - Assigned Verifier Resolution', () => {
      it('should include other assigned verifiers but exclude submitting verifier', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const round: Partial<ProjectVerificationRound> = {
          roundId: ROUND_ID,
          claimId: CLAIM_ID,
          roundType: 'first' as any,
          roundNumber: 1,
        };

        const position1: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: VERIFIER_ADDRESS,
          stake: '1000',
        };

        const position2: Partial<ProjectParticipantPosition> = {
          id: 'pos-2',
          roundId: ROUND_ID,
          participant: OTHER_VERIFIER_ADDRESS,
          stake: '2000',
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        verificationRoundRepo.find.mockResolvedValueOnce([round as ProjectVerificationRound]);
        participantPositionRepo.find.mockResolvedValueOnce([position1, position2] as ProjectParticipantPosition[]);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockVerifierUser) // submitting verifier (position1)
          .mockResolvedValueOnce(mockOtherVerifierUser) // other verifier (position2)
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining(['creator-uuid', 'other-verifier-uuid']),
          }),
          mockEntityManager,
        );

        // Verify submitting verifier is NOT in recipients
        const call = notificationPublisher.publishEvent.mock.calls[0][0];
        expect(call.recipientIds).not.toContain('verifier-uuid');
      });

      it('should handle multiple verification rounds', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const round1: Partial<ProjectVerificationRound> = {
          roundId: ROUND_ID,
          claimId: CLAIM_ID,
          roundType: 'first' as any,
          roundNumber: 1,
        };

        const round2: Partial<ProjectVerificationRound> = {
          roundId: '0x' + 'bb'.repeat(32),
          claimId: CLAIM_ID,
          roundType: 'appeal' as any,
          roundNumber: 1,
        };

        const positionsRound1: Partial<ProjectParticipantPosition>[] = [
          {
            id: 'pos-1',
            roundId: ROUND_ID,
            participant: VERIFIER_ADDRESS,
            stake: '1000',
          },
        ];

        const positionsRound2: Partial<ProjectParticipantPosition>[] = [
          {
            id: 'pos-2',
            roundId: '0x' + 'bb'.repeat(32),
            participant: OTHER_VERIFIER_ADDRESS,
            stake: '2000',
          },
        ];

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        verificationRoundRepo.find.mockResolvedValueOnce([round1, round2] as ProjectVerificationRound[]);
        participantPositionRepo.find
          .mockResolvedValueOnce(positionsRound1 as ProjectParticipantPosition[])
          .mockResolvedValueOnce(positionsRound2 as ProjectParticipantPosition[]);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockVerifierUser) // verifier from round1
          .mockResolvedValueOnce(mockOtherVerifierUser) // verifier from round2
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining(['creator-uuid', 'other-verifier-uuid']),
          }),
          mockEntityManager,
        );
      });
    });

    describe('getVerificationRecipients - Moderator Resolution', () => {
      it('should include authorized moderators (MODERATOR, ADMIN, SUPER_ADMIN)', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([mockModeratorUser, mockAdminUser]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining([
              'creator-uuid',
              'moderator-uuid',
              'admin-uuid',
            ]),
          }),
          mockEntityManager,
        );
      });

      it('should query moderators with correct roles', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser)
          .mockResolvedValueOnce(mockVerifierUser);
        verificationRoundRepo.find.mockResolvedValueOnce([]);

        const mockQueryBuilder = {
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        };
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          'user.role IN (:...roles)',
          { roles: [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN] },
        );
      });
    });

    describe('getVerificationRecipients - Self-Notification Exclusion', () => {
      it('should exclude submitting verifier from recipients', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: VERIFIER_ADDRESS, // Same as verifier
          blockNumber: '100',
          logIndex: 0,
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockVerifierUser) // claim creator (same as verifier)
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        // Should not publish if only recipient is the verifier themselves
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });
    });

    describe('getVerificationRecipients - Deduplication', () => {
      it('should deduplicate recipient IDs', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const round: Partial<ProjectVerificationRound> = {
          roundId: ROUND_ID,
          claimId: CLAIM_ID,
          roundType: 'first' as any,
          roundNumber: 1,
        };

        // Position with creator as participant (duplicate)
        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: CREATOR_ADDRESS,
          stake: '1000',
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        verificationRoundRepo.find.mockResolvedValueOnce([round as ProjectVerificationRound]);
        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockCreatorUser) // creator as participant (duplicate)
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        const call = notificationPublisher.publishEvent.mock.calls[0][0];
        // Should contain creator-uuid only once
        const creatorCount = call.recipientIds.filter((id: string) => id === 'creator-uuid').length;
        expect(creatorCount).toBe(1);
      });
    });

    describe('getVerificationRecipients - Error Handling', () => {
      it('should fail closed on query errors and return empty recipients', async () => {
        canonicalEventRepo.findOne.mockRejectedValueOnce(new Error('Database error'));

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        // Should not publish on error
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });

      it('should handle null/undefined addresses gracefully', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: null, // null actor
          blockNumber: '100',
          logIndex: 0,
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        userRepo.findOne.mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        // Should handle null actor without crashing
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });
    });

    describe('publishVerificationCompleted - Full Integration', () => {
      it('should publish event with all recipients correctly resolved', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const round: Partial<ProjectVerificationRound> = {
          roundId: ROUND_ID,
          claimId: CLAIM_ID,
          roundType: 'first' as any,
          roundNumber: 1,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: OTHER_VERIFIER_ADDRESS,
          stake: '1000',
        };

        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        verificationRoundRepo.find.mockResolvedValueOnce([round as ProjectVerificationRound]);
        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockOtherVerifierUser) // other verifier
          .mockResolvedValueOnce(mockVerifierUser); // verifier (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([mockModeratorUser]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim Title',
          'VERIFIED',
          'Well-supported evidence',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          {
            eventType: EventType.VERIFICATION_COMPLETED,
            aggregateId: ROUND_ID,
            recipientIds: expect.arrayContaining([
              'creator-uuid',
              'other-verifier-uuid',
              'moderator-uuid',
            ]),
            metadata: {
              verificationId: ROUND_ID,
              verifierId: VERIFIER_ADDRESS,
              claimId: CLAIM_ID,
              claimTitle: 'Test Claim Title',
              verdict: 'VERIFIED',
              reasoning: 'Well-supported evidence',
              claimUrl: `https://truthbounty.io/claims/${CLAIM_ID}`,
            },
            sourceUserId: VERIFIER_ADDRESS,
            tags: ['verification', 'completion'],
          },
          mockEntityManager,
        );
      });

      it('should not publish if no recipients resolved', async () => {
        canonicalEventRepo.findOne.mockResolvedValueOnce(null);
        verificationRoundRepo.find.mockResolvedValueOnce([]);
        userRepo.findOne.mockResolvedValueOnce(null); // verifier not found
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });
    });
  });

  describe('publishVerificationAssigned', () => {
    it('should publish assignment notification to verifier', async () => {
      await service.publishVerificationAssigned(
        ROUND_ID,
        VERIFIER_ADDRESS,
        CLAIM_ID,
        'Test Claim',
        CREATOR_ADDRESS,
        mockEntityManager,
      );

      expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
        {
          eventType: EventType.VERIFICATION_ASSIGNED,
          aggregateId: ROUND_ID,
          recipientIds: [VERIFIER_ADDRESS],
          metadata: {
            verificationId: ROUND_ID,
            verifierId: VERIFIER_ADDRESS,
            claimId: CLAIM_ID,
            claimTitle: 'Test Claim',
            assignorId: CREATOR_ADDRESS,
            verificationUrl: `https://truthbounty.io/verifications/${ROUND_ID}`,
          },
          sourceUserId: CREATOR_ADDRESS,
          tags: ['verification', 'assignment'],
        },
        mockEntityManager,
      );
    });
  });
});

  describe('publishVerificationContested', () => {
    describe('getContestationRecipients - Original Verifier Resolution', () => {
      it('should include original verifier from participant positions', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: VERIFIER_ADDRESS,
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockVerifierUser) // original verifier
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: EventType.VERIFICATION_CONTESTED,
            recipientIds: expect.arrayContaining(['verifier-uuid', 'creator-uuid']),
          }),
          mockEntityManager,
        );
      });

      it('should include all verifiers in the contested round', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const positions: Partial<ProjectParticipantPosition>[] = [
          {
            id: 'pos-1',
            roundId: ROUND_ID,
            participant: VERIFIER_ADDRESS,
            stake: '1000',
          },
          {
            id: 'pos-2',
            roundId: ROUND_ID,
            participant: OTHER_VERIFIER_ADDRESS,
            stake: '2000',
          },
        ];

        participantPositionRepo.find.mockResolvedValueOnce(positions as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockVerifierUser) // verifier 1
          .mockResolvedValueOnce(mockOtherVerifierUser) // verifier 2
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining([
              'verifier-uuid',
              'other-verifier-uuid',
              'creator-uuid',
            ]),
          }),
          mockEntityManager,
        );
      });

      it('should handle missing participant positions', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        // Should still include claim creator
        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining(['creator-uuid']),
          }),
          mockEntityManager,
        );
      });
    });

    describe('getContestationRecipients - Claim Creator Resolution', () => {
      it('should include claim creator from EvidenceRegistered event', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining(['creator-uuid']),
          }),
          mockEntityManager,
        );
      });

      it('should handle missing claim creator', async () => {
        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(null);
        userRepo.findOne.mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        // Should not publish if no recipients
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });
    });

    describe('getContestationRecipients - Moderator Resolution', () => {
      it('should include authorized moderators', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: VERIFIER_ADDRESS,
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockVerifierUser) // original verifier
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([mockModeratorUser, mockAdminUser]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining([
              'verifier-uuid',
              'creator-uuid',
              'moderator-uuid',
              'admin-uuid',
            ]),
          }),
          mockEntityManager,
        );
      });

      it('should query moderators with correct authorized roles', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser)
          .mockResolvedValueOnce(mockContesterUser);

        const mockQueryBuilder = {
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        };
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue(mockQueryBuilder);

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        expect(mockQueryBuilder.where).toHaveBeenCalledWith(
          'user.role IN (:...roles)',
          { roles: [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN] },
        );
      });
    });

    describe('getContestationRecipients - Self-Notification Exclusion', () => {
      it('should exclude contester from recipients', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: CONTESTER_ADDRESS, // Contester was also a verifier
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockContesterUser) // verifier (also contester)
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        const call = notificationPublisher.publishEvent.mock.calls[0][0];
        // Contester should not be in recipients
        expect(call.recipientIds).not.toContain('contester-uuid');
        expect(call.recipientIds).toContain('creator-uuid');
      });

      it('should not publish if contester was the only stakeholder', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CONTESTER_ADDRESS, // Contester is also creator
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: CONTESTER_ADDRESS, // Contester was also verifier
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockContesterUser) // verifier (contester)
          .mockResolvedValueOnce(mockContesterUser) // creator (contester)
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        // Should not publish if all stakeholders are the contester
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });
    });

    describe('getContestationRecipients - Deduplication', () => {
      it('should deduplicate recipient IDs', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: VERIFIER_ADDRESS, // Creator is also a verifier
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: VERIFIER_ADDRESS, // Same as creator
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockVerifierUser) // verifier
          .mockResolvedValueOnce(mockVerifierUser) // creator (same as verifier)
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        const call = notificationPublisher.publishEvent.mock.calls[0][0];
        // Should contain verifier-uuid only once
        const verifierCount = call.recipientIds.filter((id: string) => id === 'verifier-uuid').length;
        expect(verifierCount).toBe(1);
      });
    });

    describe('getContestationRecipients - Error Handling', () => {
      it('should fail closed on query errors and return empty recipients', async () => {
        participantPositionRepo.find.mockRejectedValueOnce(new Error('Database error'));

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        // Should not publish on error
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });

      it('should handle missing/closed claim gracefully', async () => {
        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(null); // Claim not found
        userRepo.findOne.mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        // Should not publish if claim not found
        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });

      it('should handle null/undefined verifier addresses', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: null as any, // null participant
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(null) // null verifier lookup
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        // Should still work with creator
        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            recipientIds: expect.arrayContaining(['creator-uuid']),
          }),
          mockEntityManager,
        );
      });
    });

    describe('publishVerificationContested - Full Integration', () => {
      it('should publish event with all recipients correctly resolved', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        const position: Partial<ProjectParticipantPosition> = {
          id: 'pos-1',
          roundId: ROUND_ID,
          participant: VERIFIER_ADDRESS,
          stake: '1000',
        };

        participantPositionRepo.find.mockResolvedValueOnce([position] as ProjectParticipantPosition[]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockVerifierUser) // original verifier
          .mockResolvedValueOnce(mockCreatorUser) // claim creator
          .mockResolvedValueOnce(mockContesterUser); // contester (for exclusion)
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([mockModeratorUser]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Disputed Claim Title',
          CONTESTER_ADDRESS,
          'New evidence contradicts verdict',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).toHaveBeenCalledWith(
          {
            eventType: EventType.VERIFICATION_CONTESTED,
            aggregateId: ROUND_ID,
            recipientIds: expect.arrayContaining([
              'verifier-uuid',
              'creator-uuid',
              'moderator-uuid',
            ]),
            metadata: {
              verificationId: ROUND_ID,
              claimId: CLAIM_ID,
              claimTitle: 'Disputed Claim Title',
              contesterId: CONTESTER_ADDRESS,
              reason: 'New evidence contradicts verdict',
              claimUrl: `https://truthbounty.io/claims/${CLAIM_ID}`,
            },
            sourceUserId: CONTESTER_ADDRESS,
            tags: ['verification', 'contested'],
          },
          mockEntityManager,
        );
      });

      it('should not publish if no recipients resolved', async () => {
        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(null);
        userRepo.findOne.mockResolvedValueOnce(null); // contester not found
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Evidence contradicts verdict',
          mockEntityManager,
        );

        expect(notificationPublisher.publishEvent).not.toHaveBeenCalled();
      });

      it('should include privacy-safe metadata only', async () => {
        const evidenceEvent: Partial<CanonicalEvent> = {
          eventName: 'EvidenceRegistered',
          claimId: CLAIM_ID,
          actor: CREATOR_ADDRESS,
          blockNumber: '100',
          logIndex: 0,
        };

        participantPositionRepo.find.mockResolvedValueOnce([]);
        canonicalEventRepo.findOne.mockResolvedValueOnce(evidenceEvent as CanonicalEvent);
        userRepo.findOne
          .mockResolvedValueOnce(mockCreatorUser)
          .mockResolvedValueOnce(mockContesterUser);
        (userRepo.createQueryBuilder as jest.Mock).mockReturnValue({
          where: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValueOnce([]),
        });

        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Contestation reason',
          mockEntityManager,
        );

        const call = notificationPublisher.publishEvent.mock.calls[0][0];
        // Verify no sensitive data like device tokens, private keys, etc.
        expect(call.metadata).not.toHaveProperty('deviceToken');
        expect(call.metadata).not.toHaveProperty('privateKey');
        expect(call.metadata).not.toHaveProperty('emailVerificationToken');
        expect(call.metadata).toHaveProperty('claimTitle');
        expect(call.metadata).toHaveProperty('reason');
      });
    });
  });
});
