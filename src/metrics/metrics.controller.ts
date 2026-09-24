import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service';
import { IndexerMetricsService } from './indexer-metrics.service';
import { MetricsAuthGuard } from './metrics-auth.guard';

@Controller('metrics')
@UseGuards(MetricsAuthGuard)
export class MetricsController {
  constructor(
    private readonly service: MetricsService,
    private readonly indexerMetrics: IndexerMetricsService,
  ) {}

  @Get()
  async getMetrics(@Res() res: Response) {
    await this.indexerMetrics.collect();
    res.setHeader('Content-Type', 'text/plain');
    res.send(await this.service.getMetrics());
  }
}
