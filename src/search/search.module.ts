import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { Claim } from '../claims/entities/claim.entity';
import { Dispute } from '../dispute/entities/dispute.entity';
import { User } from '../entities/user.entity';
import { RedisModule } from '../redis/redis.module';
import { AuthModule } from '../auth/auth.module';
import { WalletThrottlerGuard } from '../common/guards/wallet-throttler.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Claim, Dispute, User]),
    RedisModule,
    forwardRef(() => AuthModule),
    ConfigModule,
  ],
  providers: [SearchService, WalletThrottlerGuard],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule {}
