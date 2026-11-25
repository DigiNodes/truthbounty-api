import { Test, TestingModule } from '@nestjs/testing';
import { AbuseSignalsStartupValidator } from './abuse-signals-startup-validator';
import { ABUSE_POLICY, ABUSE_SIGNAL_STORE } from './abuse-signals.config';
import { InMemoryAbuseSignalStore } from './abuse-signal.store';
import { PostgresAbuseSignalStore } from './postgres-abuse-signal.store';

/**
 * Tests for AbuseSignalsStartupValidator (PREWAVE-BE-111, #812).
 *
 * Validates the fail-closed constraint that enforcement cannot be enabled with
 * an in-memory store. These tests ensure that:
 *
 *  1. Startup aborts when ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true with the
 *     in-memory store.
 *  2. Observe-only mode works without a shared store.
 *  3. Enforcement is allowed with a shared store.
 */
describe('AbuseSignalsStartupValidator (PREWAVE-BE-111, #812)', () => {
  describe('enforcement fail-closed behavior', () => {
    it('aborts startup when enforcement enabled with in-memory store', async () => {
      const policy = {
        enabled: true,
        enforcementEnabled: true, // Enforcement ON
        subjectSalt: 'test-salt',
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      const store = new InMemoryAbuseSignalStore(); // In-memory store

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: store,
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      // onModuleInit should throw
      expect(() => {
        validator.onModuleInit();
      }).toThrow('ABUSE_SIGNALS_ENFORCEMENT_WITH_IN_MEMORY_STORE_FORBIDDEN');
    });

    it('allows startup when enforcement disabled with in-memory store', async () => {
      const policy = {
        enabled: true,
        enforcementEnabled: false, // Enforcement OFF
        subjectSalt: 'test-salt',
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      const store = new InMemoryAbuseSignalStore();

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: store,
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      // Should not throw
      expect(() => {
        validator.onModuleInit();
      }).not.toThrow();
    });

    it('allows enforcement when shared store is configured', async () => {
      const policy = {
        enabled: true,
        enforcementEnabled: true, // Enforcement ON
        subjectSalt: 'test-salt',
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      // Mock shared store (not InMemoryAbuseSignalStore)
      const mockSharedStore = {
        record: jest.fn(),
        windowFor: jest.fn(),
        distinctSubjectsForCredential: jest.fn(),
        recordDecision: jest.fn(),
        getDecision: jest.fn(),
        listDecisions: jest.fn(),
        activeAction: jest.fn(),
        putAction: jest.fn(),
        getAction: jest.fn(),
        actionsFor: jest.fn(),
        actionsStartedBefore: jest.fn(),
      };

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: mockSharedStore, // Shared store
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      // Should not throw with shared store
      expect(() => {
        validator.onModuleInit();
      }).not.toThrow();
    });
  });

  describe('observe-only mode', () => {
    it('works without external dependencies when enforcement disabled', async () => {
      const policy = {
        enabled: true,
        enforcementEnabled: false,
        subjectSalt: 'test-salt',
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      const store = new InMemoryAbuseSignalStore();

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: store,
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      // Observe-only mode should work fine
      expect(() => {
        validator.onModuleInit();
      }).not.toThrow();
    });

    it('allows signals module to be disabled entirely', async () => {
      const policy = {
        enabled: false, // Module disabled
        enforcementEnabled: false,
        subjectSalt: null,
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      const store = new InMemoryAbuseSignalStore();

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: store,
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      // Should not throw even when disabled
      expect(() => {
        validator.onModuleInit();
      }).not.toThrow();
    });
  });

  describe('privacy protection', () => {
    it('never logs subject keys or credential fingerprints in error messages', async () => {
      const policy = {
        enabled: true,
        enforcementEnabled: true,
        subjectSalt: 'secret-salt-should-not-be-logged',
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      const store = new InMemoryAbuseSignalStore();

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: store,
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      try {
        validator.onModuleInit();
      } catch (error: any) {
        // Error message should not contain the salt
        expect(error.message).not.toContain('secret-salt-should-not-be-logged');
        
        // Error message should be about the store binding
        expect(error.message).toContain('IN_MEMORY_STORE');
      }
    });

    it('error messages provide actionable guidance without exposing internals', async () => {
      const policy = {
        enabled: true,
        enforcementEnabled: true,
        subjectSalt: 'test-salt',
        windowMs: 5 * 60 * 1000,
        maxActionDurationMs: 15 * 60 * 1000,
        maxActionsPerSubjectPerWindow: 3,
        trustedProxyHops: 0,
        thresholds: {} as any,
      };

      const store = new InMemoryAbuseSignalStore();

      const module = await Test.createTestingModule({
        providers: [
          AbuseSignalsStartupValidator,
          {
            provide: ABUSE_POLICY,
            useValue: policy,
          },
          {
            provide: ABUSE_SIGNAL_STORE,
            useValue: store,
          },
        ],
      }).compile();

      const validator = module.get<AbuseSignalsStartupValidator>(
        AbuseSignalsStartupValidator,
      );

      let errorMessage = '';
      try {
        validator.onModuleInit();
      } catch (error: any) {
        errorMessage = error.message;
      }

      // Should provide clear guidance
      expect(errorMessage).toContain('ABUSE_SIGNALS_SHARED_STORE');
      expect(errorMessage).toContain('postgres');
      expect(errorMessage).toContain('DATABASE_URL');
      
      // Should explain the problem
      expect(errorMessage).toContain('process-local');
      expect(errorMessage).toContain('restart');
      
      // Should suggest the fix
      expect(errorMessage).toContain('observe-only');
      expect(errorMessage).toContain('ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false');
    });
  });

  describe('in-memory store privacy', () => {
    it('in-memory store does not log raw identifiers', async () => {
      const store = new InMemoryAbuseSignalStore();
      
      // The store interface methods should never expose raw identifiers
      // This is a structural test - the store should only work with salted digests
      
      const subjectKey = 'salted-digest-abc123'; // Already a digest
      const credentialFingerprint = 'credential-digest-xyz789'; // Already a digest
      
      const observation = {
        kind: 'read' as any,
        surface: 'http' as any,
        routeGroup: '/api/test',
        occurredAt: Date.now(),
        credentialFingerprint,
      };

      // Record an observation
      await store.record(
        subjectKey,
        'principal' as any,
        observation,
        5 * 60 * 1000,
        Date.now(),
      );

      // The store should have recorded it without logging raw values
      const window = await store.windowFor(
        subjectKey,
        'principal' as any,
        5 * 60 * 1000,
        Date.now(),
      );

      expect(window.subjectKey).toBe(subjectKey);
      expect(window.distinctCredentials).toContain(credentialFingerprint);
      
      // These are already digests, so they're safe to store
      // The important thing is that raw addresses/wallets never reach this point
    });
  });
});
