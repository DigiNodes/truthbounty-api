import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  ABUSE_POLICY,
  ABUSE_SIGNAL_STORE,
  AbusePolicyConfig,
} from './abuse-signals.config';
import { InMemoryAbuseSignalStore } from './abuse-signal.store';

/**
 * Startup validator for abuse signals configuration (PREWAVE-BE-111, #812).
 *
 * Enforces the fail-closed constraint that enforcement cannot be enabled with
 * an in-memory store. Multi-replica deployments that enable enforcement must
 * bind a shared implementation to {@link ABUSE_SIGNAL_STORE}.
 *
 * **Why this matters:** The in-memory store is bounded and process-local.
 * Window aggregates, decisions, and actions do not survive restarts and are
 * not visible across replicas. Enabling enforcement with the in-memory adapter
 * would produce inconsistent decisions and actions that disappear on restart,
 * which violates the bounded-action and appealability guarantees.
 *
 * **Fail-closed behavior:** If enforcement is enabled and the store is
 * in-memory, startup is aborted with a clear error message. Observe-only mode
 * remains available without external dependencies.
 */
@Injectable()
export class AbuseSignalsStartupValidator implements OnModuleInit {
  private readonly logger = new Logger(AbuseSignalsStartupValidator.name);

  constructor(
    @Inject(ABUSE_POLICY)
    private readonly policy: AbusePolicyConfig,
    @Inject(ABUSE_SIGNAL_STORE)
    private readonly store: unknown,
  ) {}

  onModuleInit(): void {
    this.validateStoreBinding();
  }

  private validateStoreBinding(): void {
    const isInMemoryStore = this.store instanceof InMemoryAbuseSignalStore;

    if (this.policy.enforcementEnabled && isInMemoryStore) {
      const message = [
        'ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true requires a shared signal store.',
        '',
        'The in-memory store is process-local and bounded: window aggregates,',
        'decisions, and actions do not survive restarts and are not visible',
        'across replicas. Enabling enforcement with the in-memory adapter',
        'would produce inconsistent decisions that disappear on restart.',
        '',
        'To enable enforcement in a multi-replica deployment:',
        '  1. Set ABUSE_SIGNALS_SHARED_STORE=postgres',
        '  2. Ensure DATABASE_URL or DB_* variables are configured',
        '  3. Run migrations: npm run migration:run',
        '  4. Set ABUSE_SIGNALS_ENFORCEMENT_ENABLED=true',
        '',
        'To keep observe-only mode with the in-memory store:',
        '  - Leave ABUSE_SIGNALS_ENFORCEMENT_ENABLED=false (default)',
        '  - Signals and decisions will be recorded but not enforced',
        '',
        'Startup aborted (fail closed).',
      ].join('\n');

      this.logger.error(message);
      throw new Error(
        'ABUSE_SIGNALS_ENFORCEMENT_WITH_IN_MEMORY_STORE_FORBIDDEN',
      );
    }

    if (this.policy.enforcementEnabled) {
      this.logger.log(
        'Abuse signals enforcement enabled with shared store binding',
      );
    } else {
      this.logger.log(
        'Abuse signals in observe-only mode (enforcement disabled)',
      );
    }

    if (isInMemoryStore) {
      this.logger.log(
        'Using in-memory abuse signal store (suitable for observe-only mode)',
      );
    } else {
      this.logger.log(
        'Using shared abuse signal store (suitable for multi-replica enforcement)',
      );
    }
  }
}
