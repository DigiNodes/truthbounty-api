import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { WorldcoinController } from './worldcoin.controller';
import { WorldcoinService } from './worldcoin.service';
import { WorldIdVerification } from './entities/world-id-verification.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorldIdVerification]),
    ConfigModule,
  ],
  controllers: [WorldcoinController],
  providers: [WorldcoinService],
  exports: [WorldcoinService],
})
export class WorldcoinModule {}
