import { ProjectionChange } from './realtime.types';
import { ProjectionEventType } from './realtime.enums';

/**
 * Canonical projection payload for realtime delivery.
 *
 * The V2 REST projections are ordered and cursor-paginated over immutable
 * chain-native coordinates (blockNumber, eventLogIndex) with the row id as a
 * tiebreaker. For the WebSocket/SSE stream and the REST API to expose the
 * *same* projection, every realtime envelope must identify a row exactly the
 * way REST does. This helper is the single place that builds that identity,
 * so a WS consumer can cross-reference a streamed payload against the REST
 * read model and always land on the same row.
 *
 * The coordinate block is written first and therefore always wins over domain
 * fields, preventing an event payload from ever shadowing the row identity.
 */

export type ProjectionChangedEventType =
  | ProjectionEventType.CREATED
  | ProjectionEventType.UPDATED;

export interface CanonicalCoordinate {
  /** Row id from the projection read model (REST keyset tiebreaker). */
  id: string;
  /** Chain block number where the source event was included. */
  blockNumber: string | number;
  /** Event log index within the block (sqlite returns numbers in tests). */
  eventLogIndex: number;
  /** Source event transaction hash. */
  eventTxHash: string;
  /** Computed data state exposed by REST, when the read model computes it. */
  dataState?: string;
}

export interface CanonicalProjectionChange {
  aggregateType: string;
  aggregateId: string;
  eventType: ProjectionChangedEventType;
  coordinate: CanonicalCoordinate;
  /** Domain-specific projection fields, mirroring what REST serializes. */
  fields?: Record<string, unknown>;
  finalized?: boolean;
  /** Correlation key (e.g. the reorg-able event tx hash) for rollback pairing. */
  correlationId?: string;
}

/**
 * Build a {@link ProjectionChange} whose payload is guaranteed to carry the
 * same row identity + chain coordinates the REST API exposes for that row.
 */
export function canonicalProjectionChange(
  input: CanonicalProjectionChange,
): ProjectionChange {
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    finalized: input.finalized ?? false,
    correlationId: input.correlationId,
    payload: {
      // Domain fields are merged in first so the chain-native identity and
      // coordinate keys always win when a field name collides, preventing an
      // event payload from ever shadowing the row identity REST exposes.
      ...input.fields,
      id: input.coordinate.id,
      blockNumber: String(input.coordinate.blockNumber),
      eventLogIndex: input.coordinate.eventLogIndex,
      eventTxHash: input.coordinate.eventTxHash,
      ...(input.coordinate.dataState
        ? { dataState: input.coordinate.dataState }
        : {}),
    },
  };
}