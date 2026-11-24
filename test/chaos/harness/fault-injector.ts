export type DependencyType =
  | 'db'
  | 'redis'
  | 'rpc'
  | 'ipfs'
  | 'provider'
  | 'queue'
  | 'stream'
  | 'clock';

export type FaultMode = 'fail' | 'slow' | 'corrupt' | 'recover';

export type LegacyFaultKind =
  | 'database-restart'
  | 'redis-restart'
  | 'rpc-timeout'
  | 'rpc-divergence'
  | 'reorg'
  | 'queue-duplication'
  | 'process-crash'
  | 'disk-pressure';

export type DependencyFaultKind =
  | `${DependencyType}-${FaultMode}`
  | 'combined-failure'
  | 'retry-budget-exhaustion'
  | 'graceful-shutdown';

export type FaultKind = LegacyFaultKind | DependencyFaultKind;

export interface FaultEvent {
  kind: FaultKind;
  dependency?: DependencyType;
  mode?: FaultMode;
  at: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface FaultInjector {
  inject(
    kind: FaultKind,
    metadata?: FaultEvent['metadata'],
  ): Promise<FaultEvent>;
  recover(kind: FaultKind): Promise<FaultEvent>;
}

/**
 * Deterministic unit-test injector with scenario lifecycle and observation tracking.
 */
export class RecordingFaultInjector implements FaultInjector {
  readonly events: FaultEvent[] = [];

  async inject(
    kind: FaultKind,
    metadata?: FaultEvent['metadata'],
  ): Promise<FaultEvent> {
    const dependency = this.extractDependency(kind);
    const mode = this.extractMode(kind);

    const event: FaultEvent = {
      kind,
      dependency,
      mode,
      at: new Date().toISOString(),
      metadata,
    };
    this.events.push(event);
    return event;
  }

  async recover(kind: FaultKind): Promise<FaultEvent> {
    const dependency = this.extractDependency(kind);
    const event: FaultEvent = {
      kind,
      dependency,
      mode: 'recover',
      at: new Date().toISOString(),
      metadata: { phase: 'recovery' },
    };
    this.events.push(event);
    return event;
  }

  private extractDependency(kind: FaultKind): DependencyType | undefined {
    const parts = kind.split('-');
    const dep = parts[0] as DependencyType;
    if (['db', 'redis', 'rpc', 'ipfs', 'provider', 'queue', 'stream', 'clock'].includes(dep)) {
      return dep;
    }
    if (kind.startsWith('database')) return 'db';
    if (kind.startsWith('redis')) return 'redis';
    if (kind.startsWith('rpc')) return 'rpc';
    if (kind.startsWith('queue')) return 'queue';
    return undefined;
  }

  private extractMode(kind: FaultKind): FaultMode | undefined {
    if (kind.endsWith('-fail')) return 'fail';
    if (kind.endsWith('-slow')) return 'slow';
    if (kind.endsWith('-corrupt')) return 'corrupt';
    if (kind.endsWith('-recover')) return 'recover';
    if (kind.includes('timeout')) return 'slow';
    if (kind.includes('restart') || kind.includes('crash')) return 'fail';
    if (kind.includes('divergence') || kind.includes('duplication')) return 'corrupt';
    return undefined;
  }
}
