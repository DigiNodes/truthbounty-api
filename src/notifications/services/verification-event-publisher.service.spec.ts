import { Test, TestingModule } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { VerificationEventPublisher } from './verification-event-publisher.service';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { CanonicalEvent } from '../../v2/events/entities/canonical-event.entity';
import { User, UserRole } from '../../entities/user.entity';
import { EventType } from '../enums/event-type.enum';

describe('VerificationEventPublisher', () => {
  let service: VerificationEventPublisher;
  let mockEventPublisher: jest.Mocked<NotificationEventPublisher>;
  let mockEntityManager: jest.Mocked<EntityManager>;

  // Test data
  const claimId = '0x' + '11'.repeat(32);
  const verificationId = 'verification-123';
  const creatorAddress = '0x' + 'aa'.repeat(20);
  const verifier1Address = '0x' + 'bb'.repeat(20);
  const verifier2Address = '0x' + 'cc'.repeat(20);
  const moderatorAddress = '0x' + 'dd'.repeat(20);
  const contestorAddress = '0x' + 'ee'.repeat(20);

  beforeEach(async () => {
    // Mock NotificationEventPublisher
    mockEventPublisher = {
      publishEvent: jest.fn().mockResolvedValue({ id: 'outbox-123', status: 'PENDING' }),
    } as any;

    // Mock EntityManager with query builder pattern
    const createMockQueryBuilder = () => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getMany: jest.fn(),
    });

    mockEntityManager = {
      getRepository: jest.fn((entity) => ({
        createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
      })),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationEventPublisher,
        {
          provide: NotificationEventPublisher,
          useValue: mockEventPublisher,
        },
      ],
    }).compile();

    service = module.get<VerificationEventPublisher>(VerificationEventPublisher);
  });

  describe('publishVerificationAssigned', () => {
    it('should notify only the assigned verifier', async () => {
      await service.publishVerificationAssigned(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        creatorAddress,
        mockEntityManager,
      );

      expect(mockEventPublisher.publishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EventType.VERIFICATION_ASSIGNED,
          aggregateId: verificationId,
          recipientIds: [verifier1Address],
          sourceUserId: creatorAddress,
        }),
        mockEntityManager,
      );
    });

    it('should include privacy-safe metadata', async () => {
      await service.publishVerificationAssigned(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        creatorAddress,
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      expect(publishedEvent.metadata).toEqual({
        verificationId,
        verifierId: verifier1Address,
        claimId,
        claimTitle: 'Test Claim',
        assignorId: creatorAddress,
        verificationUrl: expect.any(String),
      });
    });
  });

  describe('publishVerificationCompleted', () => {
    it('should notify claim creator and other verifiers (excluding submitting verifier)', async () => {
      // Mock canonical event queries
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      // Mock claim creator query (EvidenceRegistered)
      mockQb.getOne.mockResolvedValueOnce({
        eventName: 'EvidenceRegistered',
        actor: creatorAddress,
        claimId,
      } as CanonicalEvent);

      // Mock verifiers query (PositionCommitted)
      mockQb.getMany.mockResolvedValueOnce([
        { eventName: 'PositionCommitted', actor: verifier1Address, claimId } as CanonicalEvent,
        { eventName: 'PositionCommitted', actor: verifier2Address, claimId } as CanonicalEvent,
      ]);

      await service.publishVerificationCompleted(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        'VERIFIED',
        'Detailed reasoning...',
        mockEntityManager,
      );

      expect(mockEventPublisher.publishEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EventType.VERIFICATION_COMPLETED,
          aggregateId: verificationId,
          // Should include creator and verifier2, but NOT verifier1 (self-notification excluded)
          recipientIds: expect.arrayContaining([
            creatorAddress.toLowerCase(),
            verifier2Address.toLowerCase(),
          ]),
        }),
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      expect(publishedEvent.recipientIds).not.toContain(verifier1Address.toLowerCase());
      expect(publishedEvent.recipientIds).toHaveLength(2);
    });

    it('should deduplicate recipients', async () => {
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      // Creator is also a verifier (same address)
      mockQb.getOne.mockResolvedValueOnce({
        actor: creatorAddress,
        claimId,
      } as CanonicalEvent);

      mockQb.getMany.mockResolvedValueOnce([
        { actor: creatorAddress, claimId } as CanonicalEvent,
        { actor: verifier1Address, claimId } as CanonicalEvent,
      ]);

      await service.publishVerificationCompleted(
        verificationId,
        verifier2Address,
        claimId,
        'Test Claim',
        'VERIFIED',
        'Reasoning',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      const recipientIds = publishedEvent.recipientIds;

      // Should deduplicate: creator appears only once
      const uniqueRecipients = new Set(recipientIds);
      expect(recipientIds.length).toBe(uniqueRecipients.size);
      expect(recipientIds).toContain(creatorAddress.toLowerCase());
      expect(recipientIds).toContain(verifier1Address.toLowerCase());
    });

    it('should fail closed when claim creator is not found', async () => {
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      // No EvidenceRegistered event found
      mockQb.getOne.mockResolvedValueOnce(null);

      await service.publishVerificationCompleted(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        'VERIFIED',
        'Reasoning',
        mockEntityManager,
      );

      // Should not publish event
      expect(mockEventPublisher.publishEvent).not.toHaveBeenCalled();
    });

    it('should fail closed when claim creator has no actor field', async () => {
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      // Event exists but actor is null (data integrity issue)
      mockQb.getOne.mockResolvedValueOnce({
        eventName: 'EvidenceRegistered',
        actor: null,
        claimId,
      } as CanonicalEvent);

      await service.publishVerificationCompleted(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        'VERIFIED',
        'Reasoning',
        mockEntityManager,
      );

      // Should not publish event
      expect(mockEventPublisher.publishEvent).not.toHaveBeenCalled();
    });

    it('should handle case where no other verifiers exist', async () => {
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      // Claim creator exists
      mockQb.getOne.mockResolvedValueOnce({
        actor: creatorAddress,
        claimId,
      } as CanonicalEvent);

      // Only the submitting verifier has submitted a position
      mockQb.getMany.mockResolvedValueOnce([
        { actor: verifier1Address, claimId } as CanonicalEvent,
      ]);

      await service.publishVerificationCompleted(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        'VERIFIED',
        'Reasoning',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      // Should only notify creator (verifier1 is excluded)
      expect(publishedEvent.recipientIds).toEqual([creatorAddress.toLowerCase()]);
    });

    it('should not include private data in metadata', async () => {
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      mockQb.getOne.mockResolvedValueOnce({
        actor: creatorAddress,
        claimId,
      } as CanonicalEvent);

      mockQb.getMany.mockResolvedValueOnce([]);

      const sensitiveReasoning = 'Contains PII: user@example.com, SSN: 123-45-6789';

      await service.publishVerificationCompleted(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        'VERIFIED',
        sensitiveReasoning,
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // Reasoning and verifierId should NOT be in metadata (privacy-safe)
      expect(publishedEvent.metadata.reasoning).toBeUndefined();
      expect(publishedEvent.metadata.verifierId).toBeUndefined();
      
      // Should only include non-sensitive fields
      expect(publishedEvent.metadata).toEqual({
        verificationId,
        claimId,
        claimTitle: 'Test Claim',
        verdict: 'VERIFIED',
        claimUrl: expect.any(String),
      });
    });

    it('should normalize addresses to lowercase', async () => {
      const mockRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockQb = (mockRepo.createQueryBuilder as jest.Mock)();

      // Mixed-case addresses from canonical events
      const mixedCaseCreator = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
      const mixedCaseVerifier = '0x1234567890AbCdEf1234567890AbCdEf12345678';

      mockQb.getOne.mockResolvedValueOnce({
        actor: mixedCaseCreator,
        claimId,
      } as CanonicalEvent);

      mockQb.getMany.mockResolvedValueOnce([
        { actor: mixedCaseVerifier, claimId } as CanonicalEvent,
      ]);

      await service.publishVerificationCompleted(
        verificationId,
        '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
        claimId,
        'Test Claim',
        'VERIFIED',
        'Reasoning',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // All addresses should be lowercase
      expect(publishedEvent.recipientIds).toEqual([
        mixedCaseCreator.toLowerCase(),
        mixedCaseVerifier.toLowerCase(),
      ]);
    });
  });

  describe('publishVerificationContested', () => {
    it('should notify moderators, original verifier, and claim creator (excluding contestor)', async () => {
      const mockCanonicalRepo = mockEntityManager.getRepository(CanonicalEvent);
      const mockUserRepo = mockEntityManager.getRepository(User);
      
      // Setup separate query builders for each repository
      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue({
                actor: creatorAddress,
                claimId,
              } as CanonicalEvent),
              getMany: jest.fn(),
            })),
          };
        } else if (entity === User) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([
                { walletAddress: moderatorAddress, role: UserRole.MODERATOR } as User,
              ]),
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      await service.publishVerificationContested(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        contestorAddress,
        'Contestation reason...',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // Should include: creator, verifier, moderator (NOT contestor)
      expect(publishedEvent.recipientIds).toContain(creatorAddress.toLowerCase());
      expect(publishedEvent.recipientIds).toContain(verifier1Address.toLowerCase());
      expect(publishedEvent.recipientIds).toContain(moderatorAddress.toLowerCase());
      expect(publishedEvent.recipientIds).not.toContain(contestorAddress.toLowerCase());
    });

    it('should handle multiple moderators', async () => {
      const moderator1 = '0x' + 'dd'.repeat(20);
      const moderator2 = '0x' + 'ee'.repeat(20);
      const admin = '0x' + 'ff'.repeat(20);

      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue({
                actor: creatorAddress,
                claimId,
              } as CanonicalEvent),
              getMany: jest.fn(),
            })),
          };
        } else if (entity === User) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([
                { walletAddress: moderator1, role: UserRole.MODERATOR } as User,
                { walletAddress: moderator2, role: UserRole.MODERATOR } as User,
                { walletAddress: admin, role: UserRole.ADMIN } as User,
              ]),
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      await service.publishVerificationContested(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        contestorAddress,
        'Reason',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // Should include all moderators and admin
      expect(publishedEvent.recipientIds).toContain(moderator1.toLowerCase());
      expect(publishedEvent.recipientIds).toContain(moderator2.toLowerCase());
      expect(publishedEvent.recipientIds).toContain(admin.toLowerCase());
    });

    it('should fail closed when claim creator is not found', async () => {
      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue(null), // No creator found
              getMany: jest.fn(),
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      await service.publishVerificationContested(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        contestorAddress,
        'Reason',
        mockEntityManager,
      );

      // Should not publish event
      expect(mockEventPublisher.publishEvent).not.toHaveBeenCalled();
    });

    it('should exclude contestor even if they are a moderator', async () => {
      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue({
                actor: creatorAddress,
                claimId,
              } as CanonicalEvent),
              getMany: jest.fn(),
            })),
          };
        } else if (entity === User) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([
                { walletAddress: contestorAddress, role: UserRole.MODERATOR } as User,
                { walletAddress: moderatorAddress, role: UserRole.MODERATOR } as User,
              ]),
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      await service.publishVerificationContested(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        contestorAddress,
        'Reason',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // Contestor should be excluded even though they're a moderator
      expect(publishedEvent.recipientIds).not.toContain(contestorAddress.toLowerCase());
      expect(publishedEvent.recipientIds).toContain(moderatorAddress.toLowerCase());
    });

    it('should not include private data in metadata', async () => {
      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue({
                actor: creatorAddress,
                claimId,
              } as CanonicalEvent),
              getMany: jest.fn(),
            })),
          };
        } else if (entity === User) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([
                { walletAddress: moderatorAddress, role: UserRole.MODERATOR } as User,
              ]),
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      const sensitiveReason = 'Contains PII: IP address 192.168.1.1';

      await service.publishVerificationContested(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        contestorAddress,
        sensitiveReason,
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // Reason and contesterId should NOT be in metadata (privacy-safe)
      expect(publishedEvent.metadata.reason).toBeUndefined();
      expect(publishedEvent.metadata.contesterId).toBeUndefined();
      
      // Should only include non-sensitive fields
      expect(publishedEvent.metadata).toEqual({
        verificationId,
        claimId,
        claimTitle: 'Test Claim',
        claimUrl: expect.any(String),
      });
    });

    it('should handle empty moderator list gracefully', async () => {
      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue({
                actor: creatorAddress,
                claimId,
              } as CanonicalEvent),
              getMany: jest.fn(),
            })),
          };
        } else if (entity === User) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([]), // No moderators
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      await service.publishVerificationContested(
        verificationId,
        verifier1Address,
        claimId,
        'Test Claim',
        contestorAddress,
        'Reason',
        mockEntityManager,
      );

      // Should still publish with creator and verifier
      expect(mockEventPublisher.publishEvent).toHaveBeenCalled();
      
      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      expect(publishedEvent.recipientIds).toContain(creatorAddress.toLowerCase());
      expect(publishedEvent.recipientIds).toContain(verifier1Address.toLowerCase());
    });
  });

  describe('recipient deduplication edge cases', () => {
    it('should handle creator who is also a verifier and moderator', async () => {
      // All roles held by the same address
      const omnipotentUser = '0x' + '99'.repeat(20);

      (mockEntityManager.getRepository as jest.Mock).mockImplementation((entity) => {
        if (entity === CanonicalEvent) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              addOrderBy: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              getOne: jest.fn().mockResolvedValue({
                actor: omnipotentUser,
                claimId,
              } as CanonicalEvent),
              getMany: jest.fn(),
            })),
          };
        } else if (entity === User) {
          return {
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              getMany: jest.fn().mockResolvedValue([
                { walletAddress: omnipotentUser, role: UserRole.MODERATOR } as User,
              ]),
            })),
          };
        }
        return { createQueryBuilder: jest.fn() };
      });

      await service.publishVerificationContested(
        verificationId,
        omnipotentUser,
        claimId,
        'Test Claim',
        contestorAddress,
        'Reason',
        mockEntityManager,
      );

      const publishedEvent = mockEventPublisher.publishEvent.mock.calls[0][0];
      
      // User should appear exactly once (deduplicated)
      const occurrences = publishedEvent.recipientIds.filter(
        (id: string) => id === omnipotentUser.toLowerCase(),
      );
      expect(occurrences).toHaveLength(1);
    });
  });
});
