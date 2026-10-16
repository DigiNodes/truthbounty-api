import {
  Context,
  propagation,
  TextMapGetter,
  TextMapPropagator,
  TextMapSetter,
} from '@opentelemetry/api';

type HeaderCarrier = Record<string, string | string[] | undefined>;

const MAX_BAGGAGE_LENGTH = 512;
const MAX_BAGGAGE_ENTRIES = 4;

const ALLOWED_VALUES: Record<string, ReadonlySet<string>> = {
  'deployment.environment': new Set([
    'development',
    'test',
    'staging',
    'production',
  ]),
  'operation.type': new Set([
    'http',
    'queue',
    'redis',
    'database',
    'indexer',
    'websocket',
    'webhook',
    'outbox',
  ]),
  'service.name': new Set(['truthbounty-api']),
};

export class SafeBaggagePropagator implements TextMapPropagator<HeaderCarrier> {
  inject(
    context: Context,
    carrier: HeaderCarrier,
    setter: TextMapSetter<HeaderCarrier>,
  ): void {
    const baggage = propagation.getBaggage(context);
    if (!baggage) return;

    const entries = baggage
      .getAllEntries()
      .filter(([key, entry]) => this.isAllowed(key, entry.value))
      .slice(0, MAX_BAGGAGE_ENTRIES)
      .map(([key, entry]) => `${key}=${entry.value}`);
    const header = entries.join(',');

    if (header && header.length <= MAX_BAGGAGE_LENGTH) {
      setter.set(carrier, 'baggage', header);
    }
  }

  extract(
    context: Context,
    carrier: HeaderCarrier,
    getter: TextMapGetter<HeaderCarrier>,
  ): Context {
    const raw = getter.get(carrier, 'baggage');
    if (
      typeof raw !== 'string' ||
      raw.length === 0 ||
      raw.length > MAX_BAGGAGE_LENGTH
    ) {
      return context;
    }

    const entries: Record<string, { value: string }> = {};
    for (const item of raw.split(',')) {
      const separator = item.indexOf('=');
      if (separator < 1) continue;

      const key = item.slice(0, separator).trim().toLowerCase();
      const value = item.slice(separator + 1).trim();
      if (this.isAllowed(key, value)) {
        entries[key] = { value };
        if (Object.keys(entries).length >= MAX_BAGGAGE_ENTRIES) break;
      }
    }

    return Object.keys(entries).length > 0
      ? propagation.setBaggage(context, propagation.createBaggage(entries))
      : context;
  }

  fields(): string[] {
    return ['baggage'];
  }

  private isAllowed(key: string, value: string): boolean {
    return ALLOWED_VALUES[key]?.has(value) ?? false;
  }
}
