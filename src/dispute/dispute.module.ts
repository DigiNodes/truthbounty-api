import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { DisputeJournalStore } from './dispute-journal.store';
import { DisputeProjectionService } from './dispute-projection.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, ConfigModule, AuthModule],
  controllers: [DisputeController],
  providers: [DisputeService, DisputeJournalStore, DisputeProjectionService],
  exports: [DisputeService],
})
export class DisputeModule {}
