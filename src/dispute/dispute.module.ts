import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DisputeController } from './dispute.controller'; 
import { DisputeService } from './dispute.service';
import { Dispute } from './entities/dispute.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Dispute])],
  controllers: [DisputeController],
  providers: [DisputeService],
  exports: [DisputeService],
})
export class DisputeModule {}