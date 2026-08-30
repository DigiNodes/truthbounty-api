import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArtifactRegistryService } from './artifact-registry.service';
import { ContractArtifact } from './entities/contract-artifact.entity';

describe('ArtifactRegistryService', () => {
  let service: ArtifactRegistryService;
  let repo: jest.Mocked<Repository<ContractArtifact>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArtifactRegistryService,
        {
          provide: getRepositoryToken(ContractArtifact),
          useValue: { findOne: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ArtifactRegistryService);
    repo = module.get(getRepositoryToken(ContractArtifact));
  });

  it('resolves an approved artifact and builds a usable Interface', async () => {
    repo.findOne.mockResolvedValue({
      id: '1',
      chainId: 10,
      contractAddress: '0xabc',
      artifactVersion: 'v1',
      abi: ['event Foo(uint256 x)'],
      isApproved: true,
      registeredAt: new Date(),
    } as ContractArtifact);

    const resolved = await service.resolve(10, '0xABC');
    expect(resolved).not.toBeNull();
    expect(resolved!.artifactVersion).toBe('v1');
    expect(resolved!.iface.getEvent('Foo')).not.toBeNull();
  });

  it('fails closed: returns null when no row exists for the address', async () => {
    repo.findOne.mockResolvedValue(null);
    const resolved = await service.resolve(10, '0xdoesnotexist');
    expect(resolved).toBeNull();
  });

  it('fails closed: the query never matches an unapproved row', async () => {
    repo.findOne.mockResolvedValue(null);
    await service.resolve(10, '0xnotyetapproved');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher typing
        where: expect.objectContaining({ isApproved: true }),
      }),
    );
  });

  it('caches a resolved artifact so repeated lookups do not re-query', async () => {
    repo.findOne.mockResolvedValue({
      id: '1',
      chainId: 10,
      contractAddress: '0xabc',
      artifactVersion: 'v1',
      abi: ['event Foo(uint256 x)'],
      isApproved: true,
      registeredAt: new Date(),
    } as ContractArtifact);

    await service.resolve(10, '0xabc');
    await service.resolve(10, '0xabc');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it('clearCache forces the next resolve to re-query', async () => {
    repo.findOne.mockResolvedValue({
      id: '1',
      chainId: 10,
      contractAddress: '0xabc',
      artifactVersion: 'v1',
      abi: ['event Foo(uint256 x)'],
      isApproved: true,
      registeredAt: new Date(),
    } as ContractArtifact);

    await service.resolve(10, '0xabc');
    service.clearCache();
    await service.resolve(10, '0xabc');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(repo.findOne).toHaveBeenCalledTimes(2);
  });
});
