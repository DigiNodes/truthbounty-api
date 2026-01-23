import { Module } from '@nestjs/common';
import { WorldcoinModule } from './worldcoin/worldcoin.module';

@Module({
  imports: [WorldcoinModule],
  exports: [WorldcoinModule],
})
export class IdentityModule {}
