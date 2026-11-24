export { DatabaseModule } from './database.module';
export { DatabaseService } from './database.service';
export type { DatabaseHealth, BoundedPoolMetrics } from './database.service';
export { TransactionRunner } from './transaction.runner';
export type { TransactionCallback } from './transaction.runner';
export {
  TransactionDeadlineExceededError,
  StatementTimeoutError,
} from './transaction.runner';
export { BaseRepository } from './base.repository';
export {
  PoolBudgetService,
  PoolBudgetExhaustedError,
} from './pool-budget.service';
export type {
  PoolBudgetMetrics,
  WorkloadBudgetSnapshot,
  PoolMetricsSink,
} from './pool-budget.service';
export {
  buildPoolConfig,
  buildPoolExtra,
  Workload,
  WORKLOADS,
  POOL_LIMITS,
} from './pool.config';
export type { PoolConfig } from './pool.config';
