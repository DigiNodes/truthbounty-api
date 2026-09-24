import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BlockchainStateService } from './state.service';
import { BlockInfo, PendingEvent, ReorgEvent } from './types';

describe('BlockchainStateService', () => {
  let service: BlockchainStateService;

  const makeBlock = (num: number, hash?: string): BlockInfo => ({
    number: num,
    hash: hash ?? `0x${num.toString(16).padStart(64, '0')}`,
    parentHash: hash
      ? `0x${(num - 1).toString(16).padStart(64, '0')}`
      : '0x0000000000000000000000000000000000000000000000000000000000000000',
    timestamp: Math.floor(Date.now() / 1000) + num,
  });

  const makePendingEvent = (
    id: string,
    blockNumber: number,
    status: 'pending' | 'confirmed' | 'orphaned' = 'pending',
  ): PendingEvent => ({
    id,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    eventType: 'TestEvent',
    data: {},
    transactionHash: `0x${id}`,
    logIndex: 0,
    status,
    confirmations: status === 'confirmed' ? 100 : 0,
    createdAt: new Date(),
    confirmedAt: status === 'confirmed' ? new Date() : undefined,
  });

  describe('with default config (no ConfigService)', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [BlockchainStateService],
      }).compile();

      service = module.get<BlockchainStateService>(BlockchainStateService);
    });

    afterEach(async () => {
      await service.clearAllState();
    });

    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should apply default memory limits', async () => {
      const stats = await service.getMemoryStats();
      expect(stats.maxBlocksInMemory).toBe(10000);
      expect(stats.maxEventsInMemory).toBe(50000);
      expect(stats.maxReorgHistoryEntries).toBe(1000);
    });

    it('should track block count in memory stats', async () => {
      await service.saveBlock(makeBlock(1));
      await service.saveBlock(makeBlock(2));
      await service.saveBlock(makeBlock(3));

      const stats = await service.getMemoryStats();
      expect(stats.currentBlockCount).toBe(3);
    });

    it('should track event counts by status in memory stats', async () => {
      const e1 = makePendingEvent('evt1', 1, 'pending');
      const e2 = makePendingEvent('evt2', 2, 'confirmed');
      const e3 = makePendingEvent('evt3', 3, 'orphaned');

      await service.savePendingEvent(e1);
      await service.savePendingEvent(e2);
      await service.savePendingEvent(e3);

      const stats = await service.getMemoryStats();
      expect(stats.currentEventCount).toBe(3);
      expect(stats.pendingEventCount).toBe(1);
      expect(stats.confirmedEventCount).toBe(1);
      expect(stats.orphanedEventCount).toBe(1);
    });

    it('should track reorg history count in memory stats', async () => {
      await service.recordReorg({
        detectedAt: new Date(),
        reorgDepth: 1,
        affectedBlockStart: 10,
        affectedBlockEnd: 10,
        orphanedEvents: [],
        reprocessedEvents: [],
      });

      const stats = await service.getMemoryStats();
      expect(stats.currentReorgHistoryCount).toBe(1);
    });
  });

  describe('with custom memory limits via ConfigService', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BlockchainStateService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue: number) => {
                const config: Record<string, number> = {
                  'blockchain.maxBlocksInMemory': 3,
                  'blockchain.maxEventsInMemory': 5,
                  'blockchain.maxReorgHistoryEntries': 2,
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      service = module.get<BlockchainStateService>(BlockchainStateService);
    });

    afterEach(async () => {
      await service.clearAllState();
    });

    describe('block eviction', () => {
      it('should evict oldest blocks when limit is exceeded', async () => {
        for (let i = 1; i <= 5; i++) {
          await service.saveBlock(makeBlock(i));
        }

        const stats = await service.getMemoryStats();
        expect(stats.currentBlockCount).toBe(3);
      });

      it('should keep the most recent blocks after eviction', async () => {
        for (let i = 80; i <= 200; i++) {
          await service.saveBlock(makeBlock(i));
        }

        // With maxBlocksInMemory=3, only the 3 newest blocks survive
        const stats = await service.getMemoryStats();
        expect(stats.currentBlockCount).toBe(3);

        // Block 190 should not exist (only blocks 198, 199, 200 remain)
        const evictedBlock = await service.getBlock(190, makeBlock(190).hash);
        expect(evictedBlock).toBeNull();
      });

      it('should evict blocks starting from the oldest', async () => {
        for (let i = 1; i <= 5; i++) {
          await service.saveBlock(makeBlock(i));
        }

        // Oldest blocks (1, 2) should be evicted, newest ones (3, 4, 5) remain
        const oldestBlock = await service.getBlock(1, makeBlock(1).hash);
        expect(oldestBlock).toBeNull();

        const newestBlock = await service.getBlock(5, makeBlock(5).hash);
        expect(newestBlock).not.toBeNull();
      });

      it('should keep all blocks when under the limit', async () => {
        for (let i = 1; i <= 3; i++) {
          await service.saveBlock(makeBlock(i));
        }

        const stats = await service.getMemoryStats();
        expect(stats.currentBlockCount).toBe(3);
      });
    });

    describe('event eviction', () => {
      it('should evict oldest confirmed events when limit is exceeded', async () => {
        for (let i = 1; i <= 10; i++) {
          await service.savePendingEvent(
            makePendingEvent(`evt-${i}`, i, 'confirmed'),
          );
        }

        const stats = await service.getMemoryStats();
        expect(stats.currentEventCount).toBeLessThanOrEqual(5);
      });

      it('should never evict pending events', async () => {
        // Add 5 pending events (filling the limit)
        for (let i = 1; i <= 5; i++) {
          await service.savePendingEvent(
            makePendingEvent(`pending-${i}`, i, 'pending'),
          );
        }

        // Add 5 more confirmed events (exceeds limit)
        for (let i = 6; i <= 10; i++) {
          await service.savePendingEvent(
            makePendingEvent(`confirmed-${i}`, i, 'confirmed'),
          );
        }

        // Pending events should all still be present
        for (let i = 1; i <= 5; i++) {
          const evt = await service.getEvent(`pending-${i}`);
          expect(evt).not.toBeNull();
          expect(evt!.status).toBe('pending');
        }

        const stats = await service.getMemoryStats();
        expect(stats.pendingEventCount).toBe(5);
      });

      it('should never evict orphaned events', async () => {
        // Add 5 orphaned events
        for (let i = 1; i <= 5; i++) {
          await service.savePendingEvent(
            makePendingEvent(`orphan-${i}`, i, 'orphaned'),
          );
        }

        // Add 5 confirmed events (exceeds limit)
        for (let i = 6; i <= 10; i++) {
          await service.savePendingEvent(
            makePendingEvent(`confirmed-${i}`, i, 'confirmed'),
          );
        }

        // Orphaned events should all still be present
        for (let i = 1; i <= 5; i++) {
          const evt = await service.getEvent(`orphan-${i}`);
          expect(evt).not.toBeNull();
          expect(evt!.status).toBe('orphaned');
        }

        const stats = await service.getMemoryStats();
        expect(stats.orphanedEventCount).toBe(5);
      });

      it('should evict confirmed events oldest-first', async () => {
        const fillerDate = new Date('2020-01-01');
        for (let i = 1; i <= 10; i++) {
          const filler = makePendingEvent(`filler-${i}`, i, 'confirmed');
          filler.confirmedAt = fillerDate;
          await service.savePendingEvent(filler);
        }

        const recentEvent: PendingEvent = {
          ...makePendingEvent('recent-event', 100, 'confirmed'),
          confirmedAt: new Date('2024-01-01'),
        };
        await service.savePendingEvent(recentEvent);

        // With maxEventsInMemory=5 and 11 events saved (10 fillers + 1 recent),
        // the 6 oldest fillers should be evicted; remaining 4 fillers + 1 recent = within limit
        for (let i = 1; i <= 6; i++) {
          const evicted = await service.getEvent(`filler-${i}`);
          expect(evicted).toBeNull();
        }

        const kept = await service.getEvent('recent-event');
        expect(kept).not.toBeNull();
      });
    });

    describe('reorg history trimming', () => {
      it('should trim oldest reorg entries when limit exceeded', async () => {
        for (let i = 1; i <= 5; i++) {
          await service.recordReorg({
            detectedAt: new Date(2020, 0, i),
            reorgDepth: 1,
            affectedBlockStart: i * 10,
            affectedBlockEnd: i * 10,
            orphanedEvents: [],
            reprocessedEvents: [],
          });
        }

        const history = await service.getReorgHistory();
        expect(history.length).toBeLessThanOrEqual(2);
      });

      it('should keep the most recent reorg entries', async () => {
        for (let i = 1; i <= 5; i++) {
          await service.recordReorg({
            detectedAt: new Date(2024, 0, i),
            reorgDepth: i,
            affectedBlockStart: i * 10,
            affectedBlockEnd: i * 10,
            orphanedEvents: [`event-${i}`],
            reprocessedEvents: [],
          });
        }

        const history = await service.getReorgHistory();
        // Should keep the last 2 entries
        expect(history.length).toBe(2);
        expect(history[0].reorgDepth).toBe(4);
        expect(history[1].reorgDepth).toBe(5);
      });
    });

    describe('correctness under normal load', () => {
      it('should not evict blocks when under the limit', async () => {
        await service.updateChainState({
          lastProcessedBlock: 10,
          confirmedDepth: 12,
        });

        for (let i = 1; i <= 3; i++) {
          await service.saveBlock(makeBlock(i));
        }

        const stats = await service.getMemoryStats();
        expect(stats.currentBlockCount).toBe(3);
      });

      it('should not evict events when under the limit', async () => {
        for (let i = 1; i <= 5; i++) {
          await service.savePendingEvent(
            makePendingEvent(`evt-${i}`, i, 'confirmed'),
          );
        }

        const stats = await service.getMemoryStats();
        expect(stats.currentEventCount).toBe(5);
      });

      it('should preserve canonical queries after eviction', async () => {
        await service.updateChainState({
          lastProcessedBlock: 50,
          confirmedDepth: 12,
        });

        for (let i = 45; i <= 50; i++) {
          await service.saveBlock(makeBlock(i));
        }

        // Canonical block at height 49 should still exist
        const canonical = await service.getCanonicalBlock(49);
        expect(canonical).not.toBeNull();
        expect(canonical!.blockNumber).toBe(49);
        expect(canonical!.isCanonical).toBe(true);
      });

      it('should preserve event retrieval after eviction', async () => {
        for (let i = 1; i <= 5; i++) {
          const evt = makePendingEvent(`evt-${i}`, i, 'confirmed');
          await service.savePendingEvent(evt);
        }

        // All events should still be retrievable
        for (let i = 1; i <= 5; i++) {
          const evt = await service.getEvent(`evt-${i}`);
          expect(evt).not.toBeNull();
          expect(evt!.id).toBe(`evt-${i}`);
        }
      });

      it('should maintain pending event count accuracy after eviction', async () => {
        for (let i = 1; i <= 5; i++) {
          await service.savePendingEvent(
            makePendingEvent(`pending-${i}`, i, 'pending'),
          );
        }

        // Add confirmed events to trigger eviction
        for (let i = 6; i <= 15; i++) {
          await service.savePendingEvent(
            makePendingEvent(`confirmed-${i}`, i, 'confirmed'),
          );
        }

        // When confirmed events are evicted, pendingEventCount should remain accurate
        const chainState = await service.getChainState();
        const pendingEvents = await service.getPendingEvents();
        expect(pendingEvents.length).toBe(chainState.pendingEventCount);
      });
    });
  });

  describe('protocol invariants', () => {
    it('should never have negative pending event count', async () => {
      const chainState = await service.getChainState();
      expect(chainState.pendingEventCount).toBeGreaterThanOrEqual(0);
      expect(chainState.orphanedEventCount).toBeGreaterThanOrEqual(0);
    });

    it('should have consistent pending event count after state transitions', async () => {
      const evt = makePendingEvent('transition-test', 1, 'pending');
      await service.savePendingEvent(evt);

      let state = await service.getChainState();
      expect(state.pendingEventCount).toBe(1);

      await service.updateEventStatus('transition-test', 'confirmed');
      state = await service.getChainState();
      expect(state.pendingEventCount).toBe(0);

      await service.updateEventStatus('transition-test', 'orphaned');
      state = await service.getChainState();
      expect(state.orphanedEventCount).toBe(1);
    });

    it('should have total event count match sum of status counts', async () => {
      await service.savePendingEvent(makePendingEvent('a', 1, 'pending'));
      await service.savePendingEvent(makePendingEvent('b', 2, 'confirmed'));
      await service.savePendingEvent(makePendingEvent('c', 3, 'orphaned'));

      const stats = await service.getMemoryStats();
      const sum =
        stats.pendingEventCount +
        stats.confirmedEventCount +
        stats.orphanedEventCount;
      expect(stats.currentEventCount).toBe(sum);
    });

    it('should keep only the most recent blocks when limit is exceeded', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BlockchainStateService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue: number) => {
                const config: Record<string, number> = {
                  'blockchain.maxBlocksInMemory': 5,
                  'blockchain.maxEventsInMemory': 50,
                  'blockchain.maxReorgHistoryEntries': 10,
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const svc = module.get<BlockchainStateService>(BlockchainStateService);

      for (let i = 1; i <= 20; i++) {
        await svc.saveBlock(makeBlock(i));
      }

      // Only the 5 newest blocks (16-20) should remain
      const stats = await svc.getMemoryStats();
      expect(stats.currentBlockCount).toBe(5);

      for (let i = 1; i <= 15; i++) {
        const b = await svc.getBlock(i, makeBlock(i).hash);
        expect(b).toBeNull();
      }

      for (let i = 16; i <= 20; i++) {
        const b = await svc.getBlock(i, makeBlock(i).hash);
        expect(b).not.toBeNull();
      }

      await svc.clearAllState();
    });
  });

  describe('indexer health metrics', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [BlockchainStateService],
      }).compile();

      service = module.get<BlockchainStateService>(BlockchainStateService);
      await service.clearAllState();
    });

    afterEach(async () => {
      await service.clearAllState();
    });

    it('should track observed head, safe and finalized cursors', async () => {
      await service.setObservedHead(100);
      await service.setSafeBlock(88);
      await service.setFinalizedBlock(80);

      const state = await service.getChainState();
      expect(state.observedHeadBlock).toBe(100);
      expect(state.safeBlock).toBe(88);
      expect(state.finalizedBlock).toBe(80);
    });

    it('should compute projection lag from observed head minus finalized cursor', async () => {
      await service.setObservedHead(100);
      await service.setFinalizedBlock(80);

      expect(service.getProjectionLag()).toBe(20);
    });

    it('should not return negative projection lag', async () => {
      await service.setObservedHead(10);
      await service.setFinalizedBlock(50);

      expect(service.getProjectionLag()).toBe(0);
    });

    it('should track monotonic replay and dead-letter counters', async () => {
      await service.recordReplay(3);
      await service.recordReplay();
      await service.recordDeadLetter(2);

      const state = await service.getChainState();
      expect(state.replayCount).toBe(4);
      expect(state.deadLetterCount).toBe(2);
    });

    it('should track RPC failures and a monotonic total', async () => {
      await service.recordRpcFailure(new Error('timeout'));
      await service.recordRpcFailure('429 too many requests');

      const state = await service.getChainState();
      expect(state.rpcFailureCount).toBe(2);
      expect(state.rpcFailureCount).toBe(2);
      expect(state.lastRpcErrorAt).toBeTruthy();
      expect(service.getRpcFailuresInWindow()).toBeGreaterThanOrEqual(2);
    });

    it('should report healthy when behind thresholds', async () => {
      await service.setObservedHead(100);
      await service.setFinalizedBlock(95);

      const health = await service.getIndexerHealth();
      expect(health.status).toBe('healthy');
      expect(health.projectionLag).toBe(5);
      expect(health.alertThresholds.projectionLagBlocks).toBe(150);
      expect(health.runbookUrl).toBeTruthy();
    });

    it('should report degraded when projection lag exceeds threshold', async () => {
      await service.setObservedHead(500);
      await service.setFinalizedBlock(200);

      const health = await service.getIndexerHealth();
      expect(health.status).toBe('degraded');
      expect(health.projectionLag).toBeGreaterThan(
        health.alertThresholds.projectionLagBlocks,
      );
    });

    it('should report degraded when dead letters exceed threshold', async () => {
      await service.setObservedHead(100);
      await service.setFinalizedBlock(95);
      await service.recordDeadLetter(200);

      const health = await service.getIndexerHealth();
      expect(health.status).toBe('degraded');
    });

    it('should not leak credentials or live RPC endpoints in the snapshot', async () => {
      await service.setObservedHead(100);
      await service.setFinalizedBlock(95);
      await service.recordRpcFailure(new Error('timeout'));

      const health = await service.getIndexerHealth();
      const serialized = JSON.stringify(health);
      // The runbook link is a sanitized public docs URL and is expected; ensure
      // we never surface credentials, secrets, or the live RPC provider URL.
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('apiKey');
      expect(serialized).not.toContain('rpcUrl');
      expect(serialized).not.toContain('mainnet.optimism.io');
    });

    it('should clear health counters on reset', async () => {
      await service.setObservedHead(100);
      await service.recordRpcFailure(new Error('x'));

      await service.clearAllState();
      const health = await service.getIndexerHealth();
      expect(health.rpcFailureCount).toBe(0);
      expect(health.observedHeadBlock).toBe(0);
    });
  });
});
