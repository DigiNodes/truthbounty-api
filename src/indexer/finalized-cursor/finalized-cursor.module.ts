import { getRuntimeEnvironment } from '../../config/runtime-config';
import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  FINALIZED_CURSOR_CONFIG,
  loadFinalizedCursorConfig,
} from './finalized-cursor.config';
import { FinalizedCursorService } from './finalized-cursor.service';
import { FINALIZED_CURSOR_STORE } from './finalized-cursor.store';
import { TypeOrmFinalizedCursorStore } from './typeorm-finalized-cursor.store';

/**
 * Canonical finalized-block ingestion cursor (PREWAVE-BE-001).
 * Kept separate from IndexerModule so health/readiness can depend on the
 * cursor without starting the event indexer loop.
 */
@Module({
  providers: [
    {
      provide: FINALIZED_CURSOR_CONFIG,
      useFactory: () => loadFinalizedCursorConfig(getRuntimeEnvironment()),
    },
    {
      provide: FINALIZED_CURSOR_STORE,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        new TypeOrmFinalizedCursorStore(dataSource),
    },
    FinalizedCursorService,
  ],
  exports: [FinalizedCursorService],
})
export class FinalizedCursorModule {}
