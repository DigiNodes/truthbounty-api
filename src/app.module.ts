import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IdentityModule } from './identity/identity.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [IdentityModule, PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
