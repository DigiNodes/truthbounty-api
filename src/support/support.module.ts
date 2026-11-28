import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SupportController } from './support.controller';
import { SupportRequestService } from './support.service';
import { SupportEncryptionService } from './support-encryption.service';
import { SupportRetentionJob } from './support-retention.job';
import { SupportRequest } from './entities/support-request.entity';

@Module({
  imports: [TypeOrmModule.forFeature([SupportRequest])],
  controllers: [SupportController],
  providers: [
    SupportRequestService,
    SupportEncryptionService,
    SupportRetentionJob,
  ],
  exports: [SupportRequestService],
})
export class SupportModule {}
