import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SybilStakingAuthorityService } from './sybil-staking-authority.service';
import { ContractArtifact } from '../v2/events/entities/contract-artifact.entity';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { UnauthorizedProvenanceException } from './sybil-resistance.types';

describe('SybilStakingAuthorityService', () => {
  let service: SybilStakingAuthorityService;
  let configValues: Record<string, string>;
  let artifact: any;
  let checkpoint: any;

  const configMap = {
    SYBIL_STAKING_CHAIN_ID: '11155420',
    SYBIL_STAKING_RELEASE_ID: 'rel-opsepolia-20261015-v2',
    SYBIL_STAKING_ARTIFACT_HASH:
      'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
    SYBIL_STAKING_CONTRACT_ADDRESS:
      '0x0000000000000000000000000000000000001004',
    SYBIL_STAKING_DEPLOYMENT_BLOCK: '1000',
  };

  const makeQb = (result: any) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
  });

  beforeEach(async () => {
    configValues = { ...configMap };
    artifact = {
      chainId: 11155420,
      contractAddress: '0x0000000000000000000000000000000000001004',
      abiChecksum: configMap.SYBIL_STAKING_ARTIFACT_HASH,
      isApproved: true,
      deploymentBlock: '1000',
    };
    checkpoint = {
      chainId: 11155420,
      contractAddress: '0x0000000000000000000000000000000000001004',
      lastSafeBlock: '24850100',
      lastFinalizedBlock: '24850000',
      lastFinalizedBlockHash:
        '0xaa183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SybilStakingAuthorityService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => configValues[key]),
          },
        },
        {
          provide: getRepositoryToken(ContractArtifact),
          useValue: {
            createQueryBuilder: jest.fn(() => makeQb(artifact)),
          },
        },
        {
          provide: getRepositoryToken(EventCheckpoint),
          useValue: {
            createQueryBuilder: jest.fn(() => makeQb(checkpoint)),
          },
        },
      ],
    }).compile();

    service = module.get<SybilStakingAuthorityService>(
      SybilStakingAuthorityService,
    );
  });

  it('resolves authority from the approved artifact and finalized checkpoint', async () => {
    const authority = await service.resolve();

    expect(authority.chainId).toBe(11155420);
    expect(authority.releaseId).toBe('rel-opsepolia-20261015-v2');
    expect(authority.artifactHash).toBe(configMap.SYBIL_STAKING_ARTIFACT_HASH);
    expect(authority.contractAddress).toBe(
      configMap.SYBIL_STAKING_CONTRACT_ADDRESS,
    );
    expect(authority.deploymentBlock).toBe(1000);
    expect(authority.finalizedThroughBlock).toBe(24850000);
    expect(authority.source).toBe('approved_runtime_registry');
    expect(authority.checkpointKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed when a runtime binding value is missing', async () => {
    delete configValues.SYBIL_STAKING_DEPLOYMENT_BLOCK;

    await expect(service.resolve()).rejects.toThrow(
      UnauthorizedProvenanceException,
    );
  });

  it('fails closed when the contract is not an approved artifact', async () => {
    artifact = null;

    await expect(service.resolve()).rejects.toThrow(
      /contract_artifact_not_approved/,
    );
  });

  it('fails closed when the artifact checksum or deployment block disagrees', async () => {
    artifact.abiChecksum = 'f'.repeat(64);

    await expect(service.resolve()).rejects.toThrow(
      /artifact_checksum_mismatch/,
    );

    artifact.abiChecksum = configMap.SYBIL_STAKING_ARTIFACT_HASH;
    artifact.deploymentBlock = '1001';

    await expect(service.resolve()).rejects.toThrow(
      /deployment_block_mismatch/,
    );
  });

  it('fails closed when the finalized checkpoint is missing or regressed', async () => {
    checkpoint = null;
    await expect(service.resolve()).rejects.toThrow(
      /finalized_checkpoint_missing/,
    );

    checkpoint = {
      chainId: 11155420,
      contractAddress: configMap.SYBIL_STAKING_CONTRACT_ADDRESS,
      lastSafeBlock: '900',
      lastFinalizedBlock: '900',
      lastFinalizedBlockHash:
        '0xaa183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22',
    };
    await expect(service.resolve()).rejects.toThrow(
      /finalized_checkpoint_invalid/,
    );
  });

  it('fails closed when the finalized block hash is absent', async () => {
    checkpoint.lastFinalizedBlockHash = null;

    await expect(service.resolve()).rejects.toThrow(
      /finalized_block_hash_missing/,
    );
  });

  it('produces a different checkpoint key on finalized block or hash changes', async () => {
    const before = await service.resolve();

    checkpoint = { ...checkpoint, lastFinalizedBlock: '24849990' };
    const regression = await service.resolve();

    checkpoint = {
      ...checkpoint,
      lastFinalizedBlock: '24850000',
      lastFinalizedBlockHash:
        '0xcc183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22',
    };
    const reorg = await service.resolve();

    expect(regression.checkpointKey).not.toBe(before.checkpointKey);
    expect(reorg.checkpointKey).not.toBe(before.checkpointKey);
    expect(await service.resolve()).toBeDefined();
  });
});
