import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TransactionHelper } from './transaction.helper';

/**
 * DatabaseModule provides global access to the PostgreSQL connection,
 * transaction helpers, and database health reporting.
 *
 * This module is @Global so all backend services can inject
 * DatabaseService and TransactionHelper without re-importing.
 */
@Global()
@Module({
  providers: [DatabaseService, TransactionHelper],
  exports: [DatabaseService, TransactionHelper],
})
export class DatabaseModule {}
