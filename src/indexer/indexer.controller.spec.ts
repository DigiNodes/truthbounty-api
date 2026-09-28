/**
 * V2-BE-125 — IndexerController unit tests
 *
 * Covers fix 2.6 (deployment-block validation on POST /indexer/backfill)
 * and regression requirement 3.10 (POST /indexer/restart resumes from
 * persisted checkpoint).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { IndexerController } from './indexer.controller';
import { EventIndexerService } from './event-indexer.service';
import { IndexerConfigService } from '../config';

const mockEventIndexerService = {
  getStatus: jest.fn().mockResolvedValue({ isRunning: true, indexingStates: [] }),
  stop: jest.fn(),
  start: jest.fn().mockResolvedValue(undefined),
  backfillFromBlock: jest.fn().mockResolvedValue(undefined),
  getDeploymentBlock: jest.fn().mockResolvedValue(null),
};

const mockIndexerConfigService = {
  getEventIndexerConfig: jest.fn().mockReturnValue({ chainId: 10 }),
};

describe('IndexerController', () => {
  let controller: IndexerController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IndexerController],
      providers: [
        { provide: EventIndexerService, useValue: mockEventIndexerService },
        { provide: IndexerConfigService, useValue: mockIndexerConfigService },
      ],
    }).compile();

    controller = module.get<IndexerController>(IndexerController);
  });

  // ── GET /indexer/status ────────────────────────────────────────────────────

  describe('GET /indexer/status', () => {
    it('returns success with indexer status', async () => {
      const result = await controller.getStatus();
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('returns failure on service error', async () => {
      mockEventIndexerService.getStatus.mockRejectedValueOnce(new Error('fail'));
      const result = await controller.getStatus();
      expect(result.success).toBe(false);
    });
  });

  // ── POST /indexer/restart (regression 3.10) ────────────────────────────────

  describe('POST /indexer/restart', () => {
    it('stops and restarts the indexer', async () => {
      const result = await controller.restart();
      expect(result.success).toBe(true);
      expect(mockEventIndexerService.stop).toHaveBeenCalled();
      expect(mockEventIndexerService.start).toHaveBeenCalled();
    });

    it('returns failure when restart throws', async () => {
      mockEventIndexerService.start.mockRejectedValueOnce(new Error('start failed'));
      const result = await controller.restart();
      expect(result.success).toBe(false);
    });
  });

  // ── POST /indexer/backfill — input validation ──────────────────────────────

  describe('POST /indexer/backfill — input validation', () => {
    it('rejects missing contractAddress', async () => {
      await expect(
        controller.backfill({ contractAddress: '', blockNumber: 1000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing blockNumber (null)', async () => {
      await expect(
        controller.backfill({ contractAddress: '0xcontract', blockNumber: null as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects negative blockNumber', async () => {
      await expect(
        controller.backfill({ contractAddress: '0xcontract', blockNumber: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-integer blockNumber', async () => {
      await expect(
        controller.backfill({ contractAddress: '0xcontract', blockNumber: 1.5 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── POST /indexer/backfill — fix 2.6: deployment-block validation ──────────

  describe('POST /indexer/backfill — fix 2.6 deployment-block validation', () => {
    it('rejects a blockNumber that predates the deployment block with HTTP 400', async () => {
      // Artifact reports deployment at block 500_000.
      mockEventIndexerService.getDeploymentBlock.mockResolvedValueOnce(500_000n);

      await expect(
        controller.backfill({
          contractAddress: '0xcontract',
          chainId: 10,
          blockNumber: 499_999, // before deployment
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockEventIndexerService.backfillFromBlock).not.toHaveBeenCalled();
    });

    it('accepts a blockNumber equal to the deployment block', async () => {
      mockEventIndexerService.getDeploymentBlock.mockResolvedValueOnce(500_000n);

      const result = await controller.backfill({
        contractAddress: '0xcontract',
        chainId: 10,
        blockNumber: 500_000, // exactly the deployment block
      });

      expect(result.success).toBe(true);
      expect(mockEventIndexerService.backfillFromBlock).toHaveBeenCalledWith(
        '0xcontract',
        500_000,
      );
    });

    it('accepts a blockNumber after the deployment block', async () => {
      mockEventIndexerService.getDeploymentBlock.mockResolvedValueOnce(500_000n);

      const result = await controller.backfill({
        contractAddress: '0xcontract',
        chainId: 10,
        blockNumber: 600_000,
      });

      expect(result.success).toBe(true);
    });

    it('skips deployment-block check when no approved artifact exists (null)', async () => {
      mockEventIndexerService.getDeploymentBlock.mockResolvedValueOnce(null);

      const result = await controller.backfill({
        contractAddress: '0xcontract',
        blockNumber: 100,
      });

      expect(result.success).toBe(true);
      expect(mockEventIndexerService.backfillFromBlock).toHaveBeenCalled();
    });

    it('uses config chainId when request omits chainId', async () => {
      mockEventIndexerService.getDeploymentBlock.mockResolvedValueOnce(null);

      await controller.backfill({
        contractAddress: '0xcontract',
        blockNumber: 100,
        // no chainId
      });

      expect(mockEventIndexerService.getDeploymentBlock).toHaveBeenCalledWith(
        10, // from config
        '0xcontract',
      );
    });

    it('error message includes the deployment block and contract address', async () => {
      mockEventIndexerService.getDeploymentBlock.mockResolvedValueOnce(500_000n);

      let errorMessage = '';
      try {
        await controller.backfill({
          contractAddress: '0xcontract',
          blockNumber: 1,
        });
      } catch (e) {
        errorMessage = (e as BadRequestException).message;
      }

      expect(errorMessage).toContain('500000');
      expect(errorMessage).toContain('0xcontract');
    });
  });
});
