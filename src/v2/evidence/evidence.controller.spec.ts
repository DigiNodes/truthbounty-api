import { Test, TestingModule } from '@nestjs/testing';
import { EvidenceController } from './evidence.controller';
import { EvidenceQueryService } from './evidence-query.service';

describe('EvidenceController', () => {
  let controller: EvidenceController;
  let queryService: jest.Mocked<EvidenceQueryService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EvidenceController],
      providers: [
        {
          provide: EvidenceQueryService,
          useValue: { getEvidence: jest.fn(), listVersions: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(EvidenceController);
    queryService = module.get(EvidenceQueryService);
  });

  it('exposes no write handlers: only GET routes exist on this controller', () => {
    const prototype = Object.getPrototypeOf(controller) as EvidenceController;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methodNames.sort()).toEqual(['getEvidence', 'listVersions']);
  });

  it('getEvidence delegates to the query service by claimId', async () => {
    const claimId = '0xclaim';
    queryService.getEvidence.mockResolvedValue({
      evidenceId: claimId,
    } as never);

    const result = await controller.getEvidence(claimId);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(queryService.getEvidence).toHaveBeenCalledWith(claimId);
    expect(result).toEqual({ evidenceId: claimId });
  });

  it('listVersions resolves the evidenceId via getEvidence before paginating versions', async () => {
    const claimId = '0xclaim';
    queryService.getEvidence.mockResolvedValue({
      evidenceId: claimId,
    } as never);
    queryService.listVersions.mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const result = await controller.listVersions(claimId, {
      cursor: 'abc',
      limit: 10,
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(queryService.getEvidence).toHaveBeenCalledWith(claimId);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock assertion, not a real unbound call
    expect(queryService.listVersions).toHaveBeenCalledWith(claimId, 'abc', 10);
    expect(result).toEqual({ items: [], nextCursor: null });
  });
});
