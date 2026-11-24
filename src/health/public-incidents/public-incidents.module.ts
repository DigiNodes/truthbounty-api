import { getRuntimeEnvironment } from '../../config/runtime-config';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublicIncidentProjectionEntity } from './entities/public-incident-projection.entity';
import { PublicIncidentController } from './public-incidents.controller';
import { PublicIncidentRateLimitGuard } from './public-incidents-rate-limit.guard';
import { PublicIncidentService } from './public-incidents.service';
import {
  PUBLIC_INCIDENT_OPTIONS,
  loadPublicIncidentOptions,
} from './public-incidents.options';

@Module({
  imports: [TypeOrmModule.forFeature([PublicIncidentProjectionEntity])],
  controllers: [PublicIncidentController],
  providers: [
    PublicIncidentService,
    PublicIncidentRateLimitGuard,
    {
      provide: PUBLIC_INCIDENT_OPTIONS,
      useFactory: () => loadPublicIncidentOptions(getRuntimeEnvironment()),
    },
  ],
  exports: [PublicIncidentService, TypeOrmModule],
})
export class PublicIncidentsModule {}
