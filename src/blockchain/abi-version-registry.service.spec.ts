import { createHash } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { LessThanOrEqual } from 'typeorm';
import { AbiVersionRegistryService } from './abi-version-registry.service';
import { AbiVersionRegistry } from './entities/abi-version-registry.entity';

const SAMPLE_ABI = [
  { type: 'function', name: 'submit', inputs: [], outputs: [] },
];
/** The canonical EIP-55 checksummed form of the contract address. */
const CONTRACT = '0xAAbbCCDdeEFF001122334455667788990011aAbb';
/** The same address lowercased, to prove lookups are casing-independent. */
const CONTRACT_LOWER = '0xaabbccddeeff001122334455667788990011aabb';
const CHAIN_ID = 10;

interface MockRepo {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function mockRepo(overrides: Partial<MockRepo> = {}): MockRepo {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) => input),
    save: jest
      .fn()
      .mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'uuid-1', ...input }),
      ),
    ...overrides,
  };
}

describe('AbiVersionRegistryService', () => {
  let service: AbiVersionRegistryService;
  let repo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    repo = mockRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AbiVersionRegistryService,
        { provide: getRepositoryToken(AbiVersionRegistry), useValue: repo },
      ],
    }).compile();
    service = module.get(AbiVersionRegistryService);
  });

  describe('register', () => {
    it('saves a new ABI entry', async () => {
      const result = await service.register({
        contractAddress: CONTRACT,
        chainId: CHAIN_ID,
        deployedAtBlock: 1000,
        version: 'v1.0.0',
        abi: SAMPLE_ABI,
      });
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(result.version).toBe('v1.0.0');
    });

    it('stores the canonical address however the caller cased it', async () => {
      await service.register({
        contractAddress: CONTRACT_LOWER,
        chainId: CHAIN_ID,
        deployedAtBlock: 1000,
        version: 'v1.0.0',
        abi: SAMPLE_ABI,
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ contractAddress: CONTRACT }),
      );
      expect(repo.findOne).toHaveBeenCalledWith({
        where: {
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: 1000,
        },
      });
    });

    it('rejects ABI drift instead of rewriting the canonical ABI', async () => {
      const otherAbi = [{ type: 'function', name: 'somethingElse' }];
      repo.findOne.mockResolvedValue({
        id: 'uuid-existing',
        contractAddress: CONTRACT,
        chainId: CHAIN_ID,
        deployedAtBlock: 1000,
        version: 'v1.0.0',
        abiJson: JSON.stringify(otherAbi),
        abiHash: createHash('sha256')
          .update(JSON.stringify(otherAbi))
          .digest('hex'),
      });
      await expect(
        service.register({
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: 1000,
          version: 'v1.0.0',
          abi: SAMPLE_ABI,
        }),
      ).rejects.toThrow(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects a negative deployedAtBlock', async () => {
      await expect(
        service.register({
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: -1,
          version: 'v1',
          abi: SAMPLE_ABI,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a fractional deployedAtBlock', async () => {
      await expect(
        service.register({
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: 1.5,
          version: 'v1',
          abi: SAMPLE_ABI,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns existing entry when ABI hash matches', async () => {
      const existing = {
        id: 'uuid-existing',
        contractAddress: CONTRACT,
        chainId: CHAIN_ID,
        deployedAtBlock: 1000,
        version: 'v1.0.0',
        abiJson: JSON.stringify(SAMPLE_ABI),
        abiHash: createHash('sha256')
          .update(JSON.stringify(SAMPLE_ABI))
          .digest('hex'),
      };
      repo.findOne.mockResolvedValue(existing);
      const result = await service.register({
        contractAddress: CONTRACT,
        chainId: CHAIN_ID,
        deployedAtBlock: 1000,
        version: 'v1.0.0',
        abi: SAMPLE_ABI,
      });
      expect(repo.save).not.toHaveBeenCalled();
      expect(result.id).toBe('uuid-existing');
    });

    it('rejects an invalid contract address', async () => {
      await expect(
        service.register({
          contractAddress: 'not-an-address',
          chainId: CHAIN_ID,
          deployedAtBlock: 1,
          version: 'v1',
          abi: SAMPLE_ABI,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an empty ABI array', async () => {
      await expect(
        service.register({
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: 1,
          version: 'v1',
          abi: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-positive chainId', async () => {
      await expect(
        service.register({
          contractAddress: CONTRACT,
          chainId: 0,
          deployedAtBlock: 1,
          version: 'v1',
          abi: SAMPLE_ABI,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resolveAbi', () => {
    it('returns parsed ABI for a matching entry', async () => {
      repo.findOne.mockResolvedValue({
        abiJson: JSON.stringify(SAMPLE_ABI),
      });
      const abi = await service.resolveAbi(CONTRACT, CHAIN_ID, 5000);
      expect(abi).toEqual(SAMPLE_ABI);
      // Resolution by block is the service's main invariant, so assert the
      // query rather than trusting that the mock ignored it.
      expect(repo.findOne).toHaveBeenCalledWith({
        where: {
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: LessThanOrEqual(5000),
        },
        order: { deployedAtBlock: 'DESC' },
      });
    });

    it('resolves a lowercase query against the canonical address', async () => {
      repo.findOne.mockResolvedValue({
        abiJson: JSON.stringify(SAMPLE_ABI),
      });
      await service.resolveAbi(CONTRACT_LOWER, CHAIN_ID, 5000);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: {
          contractAddress: CONTRACT,
          chainId: CHAIN_ID,
          deployedAtBlock: LessThanOrEqual(5000),
        },
        order: { deployedAtBlock: 'DESC' },
      });
    });

    it('rejects a non-integer atBlock', async () => {
      await expect(
        service.resolveAbi(CONTRACT, CHAIN_ID, Number.NaN),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when no ABI exists at block', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.resolveAbi(CONTRACT, CHAIN_ID, 1)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listVersions', () => {
    it('returns all versions for a contract ordered by block', async () => {
      const versions = [
        { id: '1', deployedAtBlock: 100 },
        { id: '2', deployedAtBlock: 500 },
      ];
      repo.find.mockResolvedValue(versions);
      const result = await service.listVersions(CONTRACT, CHAIN_ID);
      expect(result).toHaveLength(2);
      expect(result[0].deployedAtBlock).toBe(100);
    });

    it('looks versions up by the canonical address', async () => {
      repo.find.mockResolvedValue([]);
      await service.listVersions(CONTRACT_LOWER, CHAIN_ID);
      expect(repo.find).toHaveBeenCalledWith({
        where: { contractAddress: CONTRACT, chainId: CHAIN_ID },
        order: { deployedAtBlock: 'ASC' },
      });
    });
  });
});
