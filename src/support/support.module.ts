import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Admin } from '../admin/entities/admin.entity';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { SupportController } from './support.controller';
import { SupportRequestService } from './support.service';

@Module({
  imports: [TypeOrmModule.forFeature([Admin])],
  controllers: [SupportController],
  providers: [SupportRequestService, AdminGuard, RolesGuard],
  exports: [SupportRequestService],
})
export class SupportModule {}
