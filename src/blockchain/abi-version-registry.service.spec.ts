import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AbiVersionRegistryService } from './abi-version-registry.service';
import { AbiVersionRegistry } from './entities/abi-version-registry.entity';

const SAMPLE_ABI = [{ type: 'function', name: 'submit', inputs: [], outputs: [] }];
const CONTRACT = '0xaAbBcCdDeEfF001122334455667788990011aabb';
const CHAIN_ID = 10;

function mockRepo(overrides: Partial<any> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((d) => d),
    save: jest.fn().mockImplementation((d) => Promise.resolve({ id: 'uuid-1', ...d })),
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

    it('returns existing entry when ABI hash matches', async () => {
      const existing = {
        id: 'uuid-existing',
        contractAddress: CONTRACT,
        chainId: CHAIN_ID,
        deployedAtBlock: 1000,
        version: 'v1.0.0',
        abiJson: JSON.stringify(SAMPLE_ABI),
        abiHash: require('crypto').createHash('sha256').update(JSON.stringify(SAMPLE_ABI)).digest('hex'),
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
        service.register({ contractAddress: 'not-an-address', chainId: CHAIN_ID, deployedAtBlock: 1, version: 'v1', abi: SAMPLE_ABI }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an empty ABI array', async () => {
      await expect(
        service.register({ contractAddress: CONTRACT, chainId: CHAIN_ID, deployedAtBlock: 1, version: 'v1', abi: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-positive chainId', async () => {
      await expect(
        service.register({ contractAddress: CONTRACT, chainId: 0, deployedAtBlock: 1, version: 'v1', abi: SAMPLE_ABI }),
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
    });

    it('throws NotFoundException when no ABI exists at block', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.resolveAbi(CONTRACT, CHAIN_ID, 1)).rejects.toThrow(NotFoundException);
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
  });
});