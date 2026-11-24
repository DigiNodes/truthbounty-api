import { Test, TestingModule } from '@nestjs/testing';
import { ClaimReadModelController } from './claim-read-model.controller';
import { ClaimReadModelService } from './claim-read-model.service';

describe('ClaimReadModelController', () => {
  let controller: ClaimReadModelController;
  let service: { getList: jest.Mock; getDetail: jest.Mock };

  beforeEach(async () => {
    service = {
      getList: jest.fn().mockResolvedValue({ data: [] }),
      getDetail: jest.fn().mockResolvedValue({ data: { claimId: 'c1' } }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ClaimReadModelController],
      providers: [{ provide: ClaimReadModelService, useValue: service }],
    }).compile();

    controller = moduleRef.get(ClaimReadModelController);
  });

  it('delegates the list query to the service', async () => {
    const query = { limit: 10 } as never;
    await controller.getList(query);
    expect(service.getList).toHaveBeenCalledWith(query);
  });

  it('delegates the detail lookup to the service', async () => {
    await controller.getDetail('claim-1');
    expect(service.getDetail).toHaveBeenCalledWith('claim-1');
  });
});
