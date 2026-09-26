/**
 * Single source of truth for the V2 projection pipeline.
 *
 * The gate (V2-BE-100) decides whether an operator or a read endpoint may
 * trust a projected read model. That decision is only correct if the gate and
 * the projector agree on (a) the projector's identity and (b) exactly which
 * canonical events that projector is responsible for consuming. Duplicating
 * those two facts in the gate would let them drift silently: a projector that
 * started handling a new event name without the gate learning about it would
 * keep reporting "ready" while quietly falling behind.
 *
 * Projectors therefore import their name and handled-event list from here,
 * and the gate reads the same constants.
 */

export const V2_PROJECTORS = {
  EVIDENCE: 'v2-evidence',
  VERIFICATION: 'v2-verification',
  DISPUTES: 'v2-disputes',
} as const;

export type V2ProjectorName =
  (typeof V2_PROJECTORS)[keyof typeof V2_PROJECTORS];

/** Every projector the gate is allowed to evaluate, in stable order. */
export const V2_PROJECTOR_NAMES: readonly V2ProjectorName[] = [
  V2_PROJECTORS.EVIDENCE,
  V2_PROJECTORS.VERIFICATION,
  V2_PROJECTORS.DISPUTES,
];

/**
 * Canonical event names each projector consumes. These are the protocol's own
 * event names (see event-schema-registry.ts), never renamed by the API.
 */
export const PROJECTOR_HANDLED_EVENTS: Record<
  V2ProjectorName,
  readonly string[]
> = {
  [V2_PROJECTORS.EVIDENCE]: [
    'EvidenceRegistered',
    'EvidenceReplaced',
    'EvidenceRemoved',
  ],
  [V2_PROJECTORS.VERIFICATION]: [
    'VerificationRoundOpened',
    'PositionCommitted',
  ],
  [V2_PROJECTORS.DISPUTES]: [
    'DisputeRaised',
    'DisputeResolved',
    'DisputeExpired',
  ],
};

/**
 * Narrowing guard. An unrecognized name must never be treated as "ready":
 * the gate cannot assert anything about a projection it has no contract for.
 */
export function isV2ProjectorName(value: string): value is V2ProjectorName {
  return (V2_PROJECTOR_NAMES as readonly string[]).includes(value);
}
