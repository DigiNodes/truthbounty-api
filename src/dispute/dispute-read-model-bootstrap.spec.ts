import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FinalityPolicyService } from '../config/finality-policy.service';
import { ProjectDispute } from '../v2/disputes/entities/project-dispute.entity';
import { DisputeReadModelsModule } from '../v2/disputes/read-models/dispute-read-models.module';
import { DisputeReadModelService } from '../v2/disputes/read-models/dispute-read-model.service';
import { EventCheckpoint } from '../v2/events/entities/event-checkpoint.entity';
import { ProjectVerificationRound } from '../v2/verification/entities/project-verification-round.entity';
import { DisputeService } from './dispute.service';

// Supply the global configuration boundary without starting PostgreSQL or the
// indexer. The actual read-model module and its providers are bootstrapped.
@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: { get: () => undefined } },
    { provide: FinalityPolicyService, useValue: {} },
  ],
  exports: [ConfigService, FinalityPolicyService],
})
class TestConfigurationModule {}

describe('Canonical dispute read-model bootstrap (#868)', () => {
  it('initializes without legacy expiry providers or repository mutations', async () => {
    const repository = {
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
    };
    const builder = Test.createTestingModule({
      imports: [TestConfigurationModule, DisputeReadModelsModule],
    });
    for (const entity of [
      ProjectDispute,
      EventCheckpoint,
      ProjectVerificationRound,
    ]) {
      builder.overrideProvider(getRepositoryToken(entity)).useValue(repository);
    }
    const module = await builder.compile();
    try {
      await module.init();
      expect(module.get(DisputeReadModelService)).toBeInstanceOf(
        DisputeReadModelService,
      );
      expect(() => module.get(DisputeService)).toThrow();
      for (const method of Object.values(repository)) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      await module.close();
    }
  });
});
