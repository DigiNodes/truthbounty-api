import { Module } from '@nestjs/common';
import { AggregationService } from './aggregation.service';

@Module({
  providers: [AggregationService],
  exports: [AggregationService],
})
export class AggregationModule {}
