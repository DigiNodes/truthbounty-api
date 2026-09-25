import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DependencyGuardService } from './dependency-guard.service';

/**
 * CircuitBreakerModule
 *
 * Exports DependencyGuardService so any NestJS module can inject it to
 * protect outgoing calls to PostgreSQL, Redis, RPC, IPFS, and BullMQ.
 *
 * Usage
 * -----
 * 1. Import CircuitBreakerModule into your feature module.
 * 2. Inject DependencyGuardService.
 * 3. Wrap every external call:
 *
 *    const result = await this.guard.guard('database', () =>
 *      this.dataSource.query('SELECT 1'),
 *    );
 *
 * The guard will:
 *  - enforce a per-dependency timeout (configurable via env)
 *  - open the circuit after N consecutive failures
 *  - throw CircuitOpenError (not return null) when the circuit is open
 *  - automatically probe the dependency after the reset window expires
 */
@Module({
  imports: [ConfigModule],
  providers: [DependencyGuardService],
  exports: [DependencyGuardService],
})
export class CircuitBreakerModule {}
