import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CredentialRotationService } from './credential-rotation.service';
import { CredentialRotationController } from './credential-rotation.controller';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [ConfigModule, AdminModule],
  controllers: [CredentialRotationController],
  providers: [CredentialRotationService],
  exports: [CredentialRotationService],
})
export class CredentialRotationModule {}
