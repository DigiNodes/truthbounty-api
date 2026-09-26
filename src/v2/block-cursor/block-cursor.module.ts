import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BlockCursorService } from './block-cursor.service';

@Module({
  imports: [PrismaModule],
  providers: [BlockCursorService],
  exports: [BlockCursorService],
})
export class BlockCursorModule {}
