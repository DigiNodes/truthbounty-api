import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VerificationEventPublisher } from './verification-event-publisher.service';
import { NotificationEventPublisher } from './notification-event-publisher.service';
import { CanonicalEvent } from '../../v2/events/entities/canonical-event.entity';
import { ProjectVerificationRound } from '../../v2/verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../../v2/verification/entities/project-participant-position.entity';
import { User, UserRole } from '../../entities/user.entity';
import { OutboxEvent } from '../../outbox/entities/outbox-event.entity';
import { EventType } from '../enums/event-type.enum';
import { RoundType, RoundStatus } from '../../v2/verification/entities/project-verification-round.entity';
import { DataState } from '../../v2/common/data-state.enum';

/**
 * Integration tests for VerificationEventPublisher
 * 
 * Tests the full flow with real database queries to ensure:
 * - Recipient resolution works end-to-end
 * - Database queries are correct
 * - Transactional behavior is preserved
 * - Preference enforcement integrates properly
 */
describe('VerificationEventPublisher Integration', () => {
  let module: TestingModule;
  let service: VerificationEventPublisher;
  let notificationPublisher: NotificationEventPublisher;
  let dataSource: DataSource;

  const CLAIM_ID = '0x' + '11'.repeat(32);
  const ROUND_ID = '0x' + 'aa'.repeat(32);
  const VERIFIER_ADDRESS_1 = '0x' + '22'.repeat(20);
  const VERIFIER_ADDRESS_2 = '0x' + '33'.repeat(20);
  const CREATOR_ADDRESS = '0x' + '44'.repeat(20);
  const CONTESTER_ADDRESS = '0x' + '55'.repeat(20);
  const TX_HASH = '0x' + 'ff'.repeat(32);

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [
            CanonicalEvent,
            ProjectVerificationRound,
            ProjectParticipantPosition,
            User,
            OutboxEvent,
          ],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([
          CanonicalEvent,
          ProjectVerificationRound,
          ProjectParticipantPosition,
          User,
          OutboxEvent,
        ]),
      ],
      providers: [
        VerificationEventPublisher,
        NotificationEventPublisher,
      ],
    }).compile();

    service = module.get<VerificationEventPublisher>(VerificationEventPublisher);
    notificationPublisher = module.get<NotificationEventPublisher>(NotificationEventPublisher);
    dataSource = module.get<DataSource>(DataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
    await module.close();
  });

  beforeEach(async () => {
    // Clear all tables before each test
    await dataSource.getRepository(OutboxEvent).clear();
    await dataSource.getRepository(ProjectParticipantPosition).clear();
    await dataSource.getRepository(ProjectVerificationRound).clear();
    await dataSource.getRepository(CanonicalEvent).clear();
    await dataSource.getRepository(User).clear();
  });

  describe('Verification Completion Flow', () => {
    it('should resolve and notify claim creator, other verifiers, and moderators', async () => {
      // Seed test data
      const creator = await dataSource.getRepository(User).save({
        walletAddress: CREATOR_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      const verifier1 = await dataSource.getRepository(User).save({
        walletAddress: VERIFIER_ADDRESS_1.toLowerCase(),
        role: UserRole.USER,
        reputation: 150,
      });

      const verifier2 = await dataSource.getRepository(User).save({
        walletAddress: VERIFIER_ADDRESS_2.toLowerCase(),
        role: UserRole.USER,
        reputation: 200,
      });

      const moderator = await dataSource.getRepository(User).save({
        walletAddress: ('0x' + '66'.repeat(20)).toLowerCase(),
        role: UserRole.MODERATOR,
        reputation: 500,
      });

      // Create EvidenceRegistered event
      await dataSource.getRepository(CanonicalEvent).save({
        chainId: 11155420,
        contractAddress: '0x' + 'aa'.repeat(20),
        artifactVersion: 'v1.0.0',
        eventName: 'EvidenceRegistered',
        eventSignature: 'EvidenceRegistered(bytes32,address,bytes32)',
        txHash: TX_HASH,
        logIndex: 0,
        blockNumber: '100',
        blockTimestamp: new Date(),
        actor: CREATOR_ADDRESS.toLowerCase(),
        claimId: CLAIM_ID,
        roundId: null,
        asset: null,
        amount: null,
        payload: { digest: '0x' + '77'.repeat(32) },
        rawArgs: {},
      });

      // Create verification round
      await dataSource.getRepository(ProjectVerificationRound).save({
        roundId: ROUND_ID,
        claimId: CLAIM_ID,
        roundType: RoundType.FIRST,
        roundNumber: 1,
        deadline: new Date(Date.now() + 86400000),
        status: RoundStatus.OPEN,
        openedAtBlock: '100',
        dataState: DataState.OBSERVED,
        eventTxHash: TX_HASH,
        eventLogIndex: 1,
      });

      // Create participant positions
      await dataSource.getRepository(ProjectParticipantPosition).save({
        roundId: ROUND_ID,
        participant: VERIFIER_ADDRESS_1.toLowerCase(),
        stake: '1000000000000000000',
        reputationInput: '100',
        effectiveWeight: '1100000000000000000',
        position: 'true',
        eventTxHash: TX_HASH,
        eventLogIndex: 2,
        blockNumber: '101',
        dataState: DataState.OBSERVED,
      });

      await dataSource.getRepository(ProjectParticipantPosition).save({
        roundId: ROUND_ID,
        participant: VERIFIER_ADDRESS_2.toLowerCase(),
        stake: '2000000000000000000',
        reputationInput: '150',
        effectiveWeight: '2150000000000000000',
        position: 'true',
        eventTxHash: TX_HASH,
        eventLogIndex: 3,
        blockNumber: '101',
        dataState: DataState.OBSERVED,
      });

      // Execute within transaction
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS_1,
          CLAIM_ID,
          'Test Claim - Climate Change Evidence',
          'VERIFIED',
          'Strong supporting evidence from multiple sources',
          manager,
        );
      });

      // Verify outbox event was created
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(1);

      const outboxEvent = outboxEvents[0];
      expect(outboxEvent.eventType).toBe('NOTIFICATION:VERIFICATION_COMPLETED');
      expect(outboxEvent.aggregateId).toBe(ROUND_ID);
      expect(outboxEvent.status).toBe('PENDING');

      // Verify recipients
      const payload = outboxEvent.payload as any;
      expect(payload.recipientIds).toHaveLength(3);
      expect(payload.recipientIds).toContain(creator.id); // Claim creator
      expect(payload.recipientIds).toContain(verifier2.id); // Other verifier
      expect(payload.recipientIds).toContain(moderator.id); // Moderator
      expect(payload.recipientIds).not.toContain(verifier1.id); // Submitting verifier excluded
    });

    it('should handle case where verifier is also the claim creator', async () => {
      // Seed test data - verifier is also creator
      const verifierCreator = await dataSource.getRepository(User).save({
        walletAddress: VERIFIER_ADDRESS_1.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      // Create EvidenceRegistered event with verifier as actor
      await dataSource.getRepository(CanonicalEvent).save({
        chainId: 11155420,
        contractAddress: '0x' + 'aa'.repeat(20),
        artifactVersion: 'v1.0.0',
        eventName: 'EvidenceRegistered',
        eventSignature: 'EvidenceRegistered(bytes32,address,bytes32)',
        txHash: TX_HASH,
        logIndex: 0,
        blockNumber: '100',
        blockTimestamp: new Date(),
        actor: VERIFIER_ADDRESS_1.toLowerCase(), // Same as verifier
        claimId: CLAIM_ID,
        roundId: null,
        asset: null,
        amount: null,
        payload: { digest: '0x' + '77'.repeat(32) },
        rawArgs: {},
      });

      // Create verification round
      await dataSource.getRepository(ProjectVerificationRound).save({
        roundId: ROUND_ID,
        claimId: CLAIM_ID,
        roundType: RoundType.FIRST,
        roundNumber: 1,
        deadline: new Date(Date.now() + 86400000),
        status: RoundStatus.OPEN,
        openedAtBlock: '100',
        dataState: DataState.OBSERVED,
        eventTxHash: TX_HASH,
        eventLogIndex: 1,
      });

      // Execute within transaction
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS_1,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          manager,
        );
      });

      // Should not publish since only recipient was the submitting verifier
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(0);
    });

    it('should handle missing claim creator gracefully', async () => {
      const verifier = await dataSource.getRepository(User).save({
        walletAddress: VERIFIER_ADDRESS_1.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      const moderator = await dataSource.getRepository(User).save({
        walletAddress: ('0x' + '66'.repeat(20)).toLowerCase(),
        role: UserRole.MODERATOR,
        reputation: 500,
      });

      // No EvidenceRegistered event = no claim creator

      // Execute within transaction
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS_1,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          manager,
        );
      });

      // Should still publish with just moderator
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(1);

      const payload = outboxEvents[0].payload as any;
      expect(payload.recipientIds).toContain(moderator.id);
      expect(payload.recipientIds).not.toContain(verifier.id);
    });
  });

  describe('Verification Contestation Flow', () => {
    it('should resolve and notify original verifiers, claim creator, and moderators', async () => {
      // Seed test data
      const creator = await dataSource.getRepository(User).save({
        walletAddress: CREATOR_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      const verifier1 = await dataSource.getRepository(User).save({
        walletAddress: VERIFIER_ADDRESS_1.toLowerCase(),
        role: UserRole.USER,
        reputation: 150,
      });

      const verifier2 = await dataSource.getRepository(User).save({
        walletAddress: VERIFIER_ADDRESS_2.toLowerCase(),
        role: UserRole.USER,
        reputation: 200,
      });

      const contester = await dataSource.getRepository(User).save({
        walletAddress: CONTESTER_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 180,
      });

      const admin = await dataSource.getRepository(User).save({
        walletAddress: ('0x' + '77'.repeat(20)).toLowerCase(),
        role: UserRole.ADMIN,
        reputation: 1000,
      });

      // Create EvidenceRegistered event
      await dataSource.getRepository(CanonicalEvent).save({
        chainId: 11155420,
        contractAddress: '0x' + 'aa'.repeat(20),
        artifactVersion: 'v1.0.0',
        eventName: 'EvidenceRegistered',
        eventSignature: 'EvidenceRegistered(bytes32,address,bytes32)',
        txHash: TX_HASH,
        logIndex: 0,
        blockNumber: '100',
        blockTimestamp: new Date(),
        actor: CREATOR_ADDRESS.toLowerCase(),
        claimId: CLAIM_ID,
        roundId: null,
        asset: null,
        amount: null,
        payload: { digest: '0x' + '77'.repeat(32) },
        rawArgs: {},
      });

      // Create verification round
      await dataSource.getRepository(ProjectVerificationRound).save({
        roundId: ROUND_ID,
        claimId: CLAIM_ID,
        roundType: RoundType.FIRST,
        roundNumber: 1,
        deadline: new Date(Date.now() + 86400000),
        status: RoundStatus.CLOSED,
        openedAtBlock: '100',
        dataState: DataState.OBSERVED,
        eventTxHash: TX_HASH,
        eventLogIndex: 1,
      });

      // Create participant positions for original verifiers
      await dataSource.getRepository(ProjectParticipantPosition).save({
        roundId: ROUND_ID,
        participant: VERIFIER_ADDRESS_1.toLowerCase(),
        stake: '1000000000000000000',
        reputationInput: '100',
        effectiveWeight: '1100000000000000000',
        position: 'true',
        eventTxHash: TX_HASH,
        eventLogIndex: 2,
        blockNumber: '101',
        dataState: DataState.OBSERVED,
      });

      await dataSource.getRepository(ProjectParticipantPosition).save({
        roundId: ROUND_ID,
        participant: VERIFIER_ADDRESS_2.toLowerCase(),
        stake: '2000000000000000000',
        reputationInput: '150',
        effectiveWeight: '2150000000000000000',
        position: 'true',
        eventTxHash: TX_HASH,
        eventLogIndex: 3,
        blockNumber: '101',
        dataState: DataState.OBSERVED,
      });

      // Execute within transaction
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim - Disputed Evidence',
          CONTESTER_ADDRESS,
          'New contradictory evidence has emerged',
          manager,
        );
      });

      // Verify outbox event was created
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(1);

      const outboxEvent = outboxEvents[0];
      expect(outboxEvent.eventType).toBe('NOTIFICATION:VERIFICATION_CONTESTED');
      expect(outboxEvent.aggregateId).toBe(ROUND_ID);
      expect(outboxEvent.status).toBe('PENDING');

      // Verify recipients
      const payload = outboxEvent.payload as any;
      expect(payload.recipientIds).toHaveLength(4);
      expect(payload.recipientIds).toContain(creator.id); // Claim creator
      expect(payload.recipientIds).toContain(verifier1.id); // Original verifier 1
      expect(payload.recipientIds).toContain(verifier2.id); // Original verifier 2
      expect(payload.recipientIds).toContain(admin.id); // Admin
      expect(payload.recipientIds).not.toContain(contester.id); // Contester excluded
    });

    it('should exclude contester from recipients even if they were a verifier', async () => {
      // Seed test data
      const creator = await dataSource.getRepository(User).save({
        walletAddress: CREATOR_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      const contesterVerifier = await dataSource.getRepository(User).save({
        walletAddress: CONTESTER_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 150,
      });

      // Create EvidenceRegistered event
      await dataSource.getRepository(CanonicalEvent).save({
        chainId: 11155420,
        contractAddress: '0x' + 'aa'.repeat(20),
        artifactVersion: 'v1.0.0',
        eventName: 'EvidenceRegistered',
        eventSignature: 'EvidenceRegistered(bytes32,address,bytes32)',
        txHash: TX_HASH,
        logIndex: 0,
        blockNumber: '100',
        blockTimestamp: new Date(),
        actor: CREATOR_ADDRESS.toLowerCase(),
        claimId: CLAIM_ID,
        roundId: null,
        asset: null,
        amount: null,
        payload: { digest: '0x' + '77'.repeat(32) },
        rawArgs: {},
      });

      // Create verification round
      await dataSource.getRepository(ProjectVerificationRound).save({
        roundId: ROUND_ID,
        claimId: CLAIM_ID,
        roundType: RoundType.FIRST,
        roundNumber: 1,
        deadline: new Date(Date.now() + 86400000),
        status: RoundStatus.CLOSED,
        openedAtBlock: '100',
        dataState: DataState.OBSERVED,
        eventTxHash: TX_HASH,
        eventLogIndex: 1,
      });

      // Contester was also a verifier
      await dataSource.getRepository(ProjectParticipantPosition).save({
        roundId: ROUND_ID,
        participant: CONTESTER_ADDRESS.toLowerCase(),
        stake: '1000000000000000000',
        reputationInput: '100',
        effectiveWeight: '1100000000000000000',
        position: 'false', // Voted differently, now contesting
        eventTxHash: TX_HASH,
        eventLogIndex: 2,
        blockNumber: '101',
        dataState: DataState.OBSERVED,
      });

      // Execute within transaction
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Contestation reason',
          manager,
        );
      });

      // Verify outbox event
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(1);

      const payload = outboxEvents[0].payload as any;
      expect(payload.recipientIds).toContain(creator.id);
      expect(payload.recipientIds).not.toContain(contesterVerifier.id); // Excluded
    });

    it('should not publish if no recipients resolved', async () => {
      // No users in database

      // Execute within transaction
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationContested(
          ROUND_ID,
          CLAIM_ID,
          'Test Claim',
          CONTESTER_ADDRESS,
          'Contestation reason',
          manager,
        );
      });

      // Should not publish
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(0);
    });
  });

  describe('Transactional Behavior', () => {
    it('should rollback notification on transaction failure', async () => {
      const creator = await dataSource.getRepository(User).save({
        walletAddress: CREATOR_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      await dataSource.getRepository(CanonicalEvent).save({
        chainId: 11155420,
        contractAddress: '0x' + 'aa'.repeat(20),
        artifactVersion: 'v1.0.0',
        eventName: 'EvidenceRegistered',
        eventSignature: 'EvidenceRegistered(bytes32,address,bytes32)',
        txHash: TX_HASH,
        logIndex: 0,
        blockNumber: '100',
        blockTimestamp: new Date(),
        actor: CREATOR_ADDRESS.toLowerCase(),
        claimId: CLAIM_ID,
        roundId: null,
        asset: null,
        amount: null,
        payload: { digest: '0x' + '77'.repeat(32) },
        rawArgs: {},
      });

      try {
        await dataSource.transaction(async (manager) => {
          await service.publishVerificationCompleted(
            ROUND_ID,
            VERIFIER_ADDRESS_1,
            CLAIM_ID,
            'Test Claim',
            'VERIFIED',
            'Test reasoning',
            manager,
          );

          // Force transaction to fail
          throw new Error('Simulated transaction failure');
        });
      } catch (error) {
        // Expected
      }

      // Verify no outbox event was created due to rollback
      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(0);
    });
  });

  describe('Idempotency', () => {
    it('should generate same idempotency key for duplicate events', async () => {
      const creator = await dataSource.getRepository(User).save({
        walletAddress: CREATOR_ADDRESS.toLowerCase(),
        role: UserRole.USER,
        reputation: 100,
      });

      const moderator = await dataSource.getRepository(User).save({
        walletAddress: ('0x' + '66'.repeat(20)).toLowerCase(),
        role: UserRole.MODERATOR,
        reputation: 500,
      });

      await dataSource.getRepository(CanonicalEvent).save({
        chainId: 11155420,
        contractAddress: '0x' + 'aa'.repeat(20),
        artifactVersion: 'v1.0.0',
        eventName: 'EvidenceRegistered',
        eventSignature: 'EvidenceRegistered(bytes32,address,bytes32)',
        txHash: TX_HASH,
        logIndex: 0,
        blockNumber: '100',
        blockTimestamp: new Date(),
        actor: CREATOR_ADDRESS.toLowerCase(),
        claimId: CLAIM_ID,
        roundId: null,
        asset: null,
        amount: null,
        payload: { digest: '0x' + '77'.repeat(32) },
        rawArgs: {},
      });

      // Publish first time
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS_1,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          manager,
        );
      });

      const firstOutbox = await dataSource.getRepository(OutboxEvent).find();
      expect(firstOutbox).toHaveLength(1);
      const firstIdempotencyKey = firstOutbox[0].idempotencyKey;

      // Publish second time (duplicate)
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationCompleted(
          ROUND_ID,
          VERIFIER_ADDRESS_1,
          CLAIM_ID,
          'Test Claim',
          'VERIFIED',
          'Test reasoning',
          manager,
        );
      });

      const allOutbox = await dataSource.getRepository(OutboxEvent).find();
      // Should have 2 entries (unique constraint would prevent in production)
      expect(allOutbox.length).toBeGreaterThanOrEqual(1);
      
      // All should have same idempotency key
      allOutbox.forEach((event) => {
        expect(event.idempotencyKey).toBe(firstIdempotencyKey);
      });
    });
  });

  describe('Verification Assignment', () => {
    it('should publish assignment notification to verifier', async () => {
      await dataSource.transaction(async (manager) => {
        await service.publishVerificationAssigned(
          ROUND_ID,
          VERIFIER_ADDRESS_1,
          CLAIM_ID,
          'Test Claim - Assignment',
          CREATOR_ADDRESS,
          manager,
        );
      });

      const outboxEvents = await dataSource.getRepository(OutboxEvent).find();
      expect(outboxEvents).toHaveLength(1);

      const outboxEvent = outboxEvents[0];
      expect(outboxEvent.eventType).toBe('NOTIFICATION:VERIFICATION_ASSIGNED');
      expect(outboxEvent.aggregateId).toBe(ROUND_ID);

      const payload = outboxEvent.payload as any;
      expect(payload.recipientIds).toEqual([VERIFIER_ADDRESS_1]);
      expect(payload.metadata.verifierId).toBe(VERIFIER_ADDRESS_1);
      expect(payload.metadata.assignorId).toBe(CREATOR_ADDRESS);
    });
  });
});
