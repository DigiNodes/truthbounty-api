import { Test, TestingModule } from '@nestjs/testing';
import { ClaimFeedController } from './claim-feed.controller';
import { ClaimFeedService } from './claim-feed.service';

describe('ClaimFeedController', () => {
  let controller: ClaimFeedController;
  let service: ClaimFeedService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClaimFeedController],
      providers: [
        {
          provide: ClaimFeedService,
          useValue: {
            getFeed: jest.fn(),
            getDetail: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ClaimFeedController>(ClaimFeedController);
    service = module.get<ClaimFeedService>(ClaimFeedService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getFeed', () => {
    it('should delegate to service with the query DTO', async () => {
      const feedResult = {
        data: [{ id: 'c1' }],
        pagination: { nextCursor: null, hasMore: false },
      };
      jest.spyOn(service, 'getFeed').mockResolvedValue(feedResult as any);

      const result = await controller.getFeed({ limit: 10 } as any);

      expect(service.getFeed).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toEqual(feedResult);
    });
  });

  describe('getDetail', () => {
    it('should delegate to service with the id param', async () => {
      const detail = { id: 'c1', title: 'Test' };
      jest.spyOn(service, 'getDetail').mockResolvedValue(detail as any);

      const result = await controller.getDetail({ id: 'c1' });

      expect(service.getDetail).toHaveBeenCalledWith('c1');
      expect(result).toEqual(detail);
    });
  });
});
