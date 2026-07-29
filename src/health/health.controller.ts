import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { HealthService } from './health.service';
import {
  DependencyHealthResult,
  HealthCheckResult,
  LivenessResult,
  ReadinessResult,
  StartupResult,
} from './health.types';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): LivenessResult {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  async ready(@Res() res: Response): Promise<void> {
    const result: ReadinessResult = await this.healthService.getReadiness();
    const statusCode = result.ready
      ? HttpStatus.OK
      : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(statusCode).json(result);
  }

  @Get('startup')
  @ApiOperation({ summary: 'Startup probe' })
  async startup(@Res() res: Response): Promise<void> {
    const result: StartupResult = await this.healthService.getStartup();
    const statusCode = result.startupComplete && result.ready
      ? HttpStatus.OK
      : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(statusCode).json(result);
  }

  @Get('dependencies')
  @ApiOperation({ summary: 'Dependency health report' })
  dependencies(): DependencyHealthResult {
    return this.healthService.getDependencyHealth();
  }

  @Get()
  @ApiOperation({ summary: 'Aggregated health report' })
  async health(@Res() res: Response): Promise<void> {
    const result: HealthCheckResult = await this.healthService.getHealth();
    const statusCode = result.status === 'unhealthy'
      ? HttpStatus.SERVICE_UNAVAILABLE
      : HttpStatus.OK;
    res.status(statusCode).json(result);
  }
}
