import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportRequestService } from './support.service';

@Module({
  controllers: [SupportController],
  providers: [SupportRequestService],
  exports: [SupportRequestService],
})
export class SupportModule {}
