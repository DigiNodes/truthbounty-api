
import { GoneException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RewardsController } from './rewards.controller';

describe('RewardsController — legacy API deprecation', () => {
  let controller: RewardsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RewardsController],
    }).compile();

    controller = module.get<RewardsController>(RewardsController);
  });

  it('GET /rewards returns 410 Gone', () => {
    try {
      controller.findAll();
    } catch (error) {
      expect(error).toBeInstanceOf(GoneException);
      expect((error as GoneException).getStatus()).toBe(410);
      expect((error as GoneException).message).toContain(
        '/api/v2/claims/{claimId}/rewards',
      );
    }
  });

  it('GET /rewards/:id returns 410 Gone', () => {
    try {
      controller.findOne();
    } catch (error) {
      expect(error).toBeInstanceOf(GoneException);
      expect((error as GoneException).getStatus()).toBe(410);
      expect((error as GoneException).message).toContain(
        'no direct V2 equivalent',
      );
    }
  });

  it('does not expose generic CRUD write methods', () => {
    const prototype = Object.getPrototypeOf(controller);

    expect(prototype.create).toBeUndefined();
    expect(prototype.update).toBeUndefined();
    expect(prototype.remove).toBeUndefined();
  });
});
