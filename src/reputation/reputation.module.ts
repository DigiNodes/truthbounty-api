import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReputationService } from './reputation.service';
import { User } from '../entities/user.entity';
import { ReputationChange } from '../entities/reputation-change.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, ReputationChange])],
  providers: [ReputationService],
  exports: [ReputationService],
})
export class ReputationModule {}
