export type FaultKind =
  | 'database-restart'
  | 'redis-restart'
  | 'rpc-timeout'
  | 'rpc-divergence'
  | 'reorg'
  | 'queue-duplication'
  | 'process-crash'
  | 'disk-pressure';

export interface FaultEvent {
  kind: FaultKind;
  at: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface FaultInjector {
  inject(kind: FaultKind, metadata?: FaultEvent['metadata']): Promise<FaultEvent>;
  recover(kind: FaultKind): Promise<FaultEvent>;
}

/**
 * Deterministic unit-test injector.
 *
 * Production/container operations must be implemented in repository-specific
 * adapters. This class only records the scenario lifecycle.
 */
export class RecordingFaultInjector implements FaultInjector {
  readonly events: FaultEvent[] = [];

  async inject(
    kind: FaultKind,
    metadata?: FaultEvent['metadata'],
  ): Promise<FaultEvent> {
    const event = { kind, at: new Date().toISOString(), metadata };
    this.events.push(event);
    return event;
  }

  async recover(kind: FaultKind): Promise<FaultEvent> {
    const event = {
      kind,
      at: new Date().toISOString(),
      metadata: { phase: 'recovery' },
    };
    this.events.push(event);
    return event;
  }
}
