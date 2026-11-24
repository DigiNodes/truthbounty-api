import { AbuseObservationKind, AbuseSurface } from '../abuse-signals.types';

/**
 * False-positive fixtures for abuse detection (PREWAVE-BE-086, #681).
 *
 * Every fixture here is **benign traffic that a naive threshold trips**. They
 * exist so the test suite can prove the corroboration rule does its job: a
 * single loud axis produces a finding, never an action.
 *
 * The cases are drawn from shapes that really occur in production:
 *  - a polling dashboard hammering one read route,
 *  - a bulk importer submitting many *distinct* payloads,
 *  - a user who fat-fingers several passwords before succeeding,
 *  - a websocket client reconnecting noisily,
 *  - a user resubmitting a support form because the first attempt looked lost,
 *  - an integrator re-registering endpoints during a migration.
 *
 * All timestamps share a base so a whole fixture lands in one window.
 */
export const FIXTURE_NOW = 1_700_000_000_000;
export const FIXTURE_WINDOW_MS = 5 * 60 * 1000;

interface ObservationInit {
  kind: AbuseObservationKind;
  surface: AbuseSurface;
  routeGroup: string;
  method?: string;
  outcome?: 'success' | 'failure';
  credentialFingerprint?: string;
  payloadFingerprint?: string;
}

function observation(init: ObservationInit, offsetMs = 0) {
  return {
    kind: init.kind,
    surface: init.surface,
    routeGroup: init.routeGroup,
    method: init.method ?? 'GET',
    outcome: init.outcome ?? 'success',
    occurredAt: FIXTURE_NOW + offsetMs,
    credentialFingerprint: init.credentialFingerprint,
    payloadFingerprint: init.payloadFingerprint,
  };
}

/** A read-only dashboard polling one route far above human browsing pace. */
export const pollingDashboard = (count = 4_000) =>
  Array.from({ length: count }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: 'claims/list',
      },
      i,
    ),
  );

/**
 * A legitimate bulk importer: high write volume, every payload distinct.
 *
 * Trips write velocity alone. Because the payloads do not repeat, the second
 * corroborating dimension never fires and the decision must be suppressed.
 */
export const bulkImporterDistinctPayloads = (count = 120) =>
  Array.from({ length: count }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.WRITE,
        surface: AbuseSurface.CLAIMS,
        routeGroup: 'claims',
        method: 'POST',
        payloadFingerprint: `payload-${i}`,
      },
      i,
    ),
  );

/** A user trying several wrong passwords, then succeeding. */
export const fatFingeredPassword = (wrong = 4) => [
  ...Array.from({ length: wrong }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.AUTH_FAILURE,
        surface: AbuseSurface.AUTH,
        routeGroup: 'auth/login',
        method: 'POST',
        outcome: 'failure',
        credentialFingerprint: `credential-${i}`,
      },
      i,
    ),
  ),
  observation(
    {
      kind: AbuseObservationKind.AUTH_SUCCESS,
      surface: AbuseSurface.AUTH,
      routeGroup: 'auth/login',
      method: 'POST',
      credentialFingerprint: 'credential-final',
    },
    wrong,
  ),
];

/** A websocket client reconnecting often but never holding many sockets. */
export const noisyReconnectingClient = (cycles = 40) =>
  Array.from({ length: cycles }, (_, i) => [
    observation(
      {
        kind: AbuseObservationKind.STREAM_CONNECT,
        surface: AbuseSurface.STREAM,
        routeGroup: 'realtime/events',
      },
      i * 2,
    ),
    observation(
      {
        kind: AbuseObservationKind.STREAM_DISCONNECT,
        surface: AbuseSurface.STREAM,
        routeGroup: 'realtime/events',
      },
      i * 2 + 1,
    ),
  ]).flat();

/**
 * A user resubmitting a support form because the first attempt looked lost.
 *
 * Trips both support dimensions individually at low levels, so the fixture is
 * sized to stay under the thresholds rather than to be suppressed by
 * corroboration.
 */
export const resubmittedSupportRequests = (count = 14, distinct = 7) =>
  Array.from({ length: count }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.WRITE,
        surface: AbuseSurface.SUPPORT,
        routeGroup: `support/contact-${i % distinct}`,
        method: 'POST',
        payloadFingerprint: `support-payload-${i % distinct}`,
      },
      i,
    ),
  );

/** An integrator re-registering endpoints during a planned migration. */
export const endpointMigration = (count = 12) =>
  Array.from({ length: count }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.WEBHOOK_ENDPOINT_WRITE,
        surface: AbuseSurface.WEBHOOK,
        routeGroup: 'webhooks',
        method: 'POST',
      },
      i,
    ),
  );

/** An anonymous reader walking a broad but human-paced slice of the API. */
export const slowAnonymousReader = (count = 90) =>
  Array.from({ length: count }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: i % 2 === 0 ? 'claims/list' : 'claims/detail',
      },
      i * 3,
    ),
  );

/**
 * An abusive shape, for contrast: anonymous breadth *and* velocity together.
 * The fixture set is useful only if it contains a positive.
 */
export const horizontalCrawler = (count = 1_500, routes = 90) =>
  Array.from({ length: count }, (_, i) =>
    observation(
      {
        kind: AbuseObservationKind.READ,
        surface: AbuseSurface.HTTP,
        routeGroup: `section-${i % routes}`,
      },
      i,
    ),
  );

/** One credential fingerprint presented from many distinct subjects. */
export const distributedCredentialSpray = (
  subjectCount = 40,
  attemptsPerSubject = 3,
) =>
  Array.from({ length: subjectCount }, (_, s) =>
    Array.from({ length: attemptsPerSubject }, (_, a) =>
      observation(
        {
          kind: AbuseObservationKind.AUTH_FAILURE,
          surface: AbuseSurface.AUTH,
          routeGroup: 'auth/login',
          method: 'POST',
          outcome: 'failure',
          credentialFingerprint: 'credential-shared',
        },
        s * 100 + a,
      ),
    ),
  ).flat();

/** Every benign fixture, keyed by the reason it must not be actioned. */
export const FALSE_POSITIVE_FIXTURES = {
  pollingDashboard,
  bulkImporterDistinctPayloads,
  fatFingeredPassword,
  noisyReconnectingClient,
  resubmittedSupportRequests,
  endpointMigration,
  slowAnonymousReader,
} as const;