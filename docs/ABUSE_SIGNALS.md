# Abuse Signals (PREWAVE-BE-086, issue #681)

Detects scraping, credential stuffing, spam submissions, webhook abuse, stream
storms and support flooding — and stops there.

## The one-paragraph version

Abuse signals are advisory to the API's **own delivery surface**. A signal can
throttle, challenge or suspend an API caller for a bounded period. It cannot
touch a claim, a verification, a dispute, a reward, the treasury, governance or
any other canonical fact. Those remain reproducible from finalized canonical
contract events, and the deployed contracts remain authoritative. If you find
yourself wanting an abuse signal to change a protocol outcome, that is the wrong
tool and the wrong boundary.

## Activation

Two independent gates, deliberately separate:

| Variable | Default | Effect when true |
|---|---|---|
| `ABUSE_SIGNALS_ENABLED` | `true` | Observations and decisions are recorded. Nothing is refused. |
| `ABUSE_SIGNALS_ENFORCEMENT_ENABLED` | **`false`** | A decision may refuse a request. |

Enforcement is off by default on purpose. This is a pre-wave candidate:
detection is safe to merge and observe, automated refusal is not something to
ship unannounced. Turning enforcement on is a maintainer decision, made after
watching the observed-only data.

`GET /v1/abuse-signals/status` (admin plane) reports both gates and whether a
complete release binding is configured.

## What gets detected

| Class | Reason codes | Dimensions |
|---|---|---|
| Scraping | `scrape_sustained_read_velocity`, `scrape_high_breadth_anonymous` | `read_volume`, `route_breadth` |
| Credential stuffing | `credential_stuffing_distinct_credentials`, `credential_stuffing_distinct_subjects` | `credential_spread`, `subject_spread` |
| Spam submissions | `spam_submission_write_burst`, `spam_submission_duplicate_payload` | `write_velocity`, `payload_repetition` |
| Webhook abuse | `webhook_endpoint_churn`, `webhook_secret_rotation_abuse`, `webhook_delivery_storm` | `endpoint_churn`, `secret_rotation`, `delivery_storm` |
| Stream storms | `stream_connection_storm`, `stream_subscribe_storm`, `stream_message_storm` | `connection_pressure`, `subscribe_pressure`, `message_pressure` |
| Support flooding | `support_volume_flood`, `support_duplicate_flood`, `support_contact_fanout` | `request_volume`, `duplicate_pressure`, `contact_fanout` |

`insufficient_corroboration` is recorded when signals fired but did not clear
the corroboration bar. It is a real outcome, not a null: suppression is
observable so a mis-tuned threshold is visible instead of silent.

### The corroboration rule

A finding only becomes an action when enough **independent dimensions** agree
within the same abuse class. Two signals measuring the same thing corroborate
nothing.

Every class that can misfire on a shared NAT or on legitimate automation
(scraping, spam, support flooding) requires at least two. A subject identified
only by a masked network prefix always requires at least two, whatever the
registry says.

This is why the false-positive fixtures in
`src/abuse-signals/fixtures/abuse-observations.fixtures.ts` stay suppressed:

- a polling dashboard trips `read_volume` only → suppressed
- a bulk importer with distinct payloads trips `write_velocity` only → suppressed
- a user fat-fingering four passwords trips nothing → no signal
- a reconnecting websocket client holds zero live sockets → no signal

## Identity: what may identify a subject

Only three things, in this order:

1. a validated JWT principal (`sub`)
2. a wallet address carried **inside** that validated JWT
3. the socket address, masked to a /24 (IPv4) or /64 (IPv6)

Everything a caller supplies about itself is ignored. `x-wallet-address`,
`x-wallet`, `x-api-key`, `x-auth-request-wallet` and `x-forwarded-wallet` never
identify anybody; forging one cannot move traffic onto or off somebody else's
budget. `X-Forwarded-For` is honoured only for the configured
`ABUSE_SIGNALS_TRUSTED_PROXY_HOPS`, taken from the **right**, so a client cannot
prepend entries to widen its own trusted prefix.

The stored key is an HMAC of `(kind, value)` under `ABUSE_SIGNALS_SUBJECT_SALT`.
It is not reversible, so signals and audit records do not become a personal-data
store.

### Shared NAT

Anonymous traffic is bucketed to a masked prefix, never a single address, so a
shared office, campus or carrier egress collapses into one coarse subject rather
than punishing one unlucky bystander. The cost is resolution: an action against
a prefix affects everyone behind it, which is why the corroboration bar is
stricter for that subject kind and why an appeal is always available.

### Attacker-controlled identifiers

A caller that supplies only forged identifiers is reported as unattributed. The
module never falls back to trusting the forged value in order to have something
to record.

## Actions are bounded, time-limited and appealable

Ladder: `none → observe → throttle → challenge → suspend`.

- Every action carries `expiresAt`, strictly after `startedAt`. An action
  without a valid future expiry is never issued and never enforced.
- Duration is clamped by `ABUSE_SIGNALS_MAX_ACTION_SECONDS` and, regardless of
  configuration, by a hard 24-hour ceiling.
- Escalation counts windows in which the subject was already actioned, capped by
  `ABUSE_SIGNALS_MAX_ACTIONS_PER_SUBJECT`. Counting *windows* rather than
  evaluation calls is what keeps one abusive window from walking a scraper up
  the ladder in seconds.
- `appealable` is always `true`.
- `THROTTLE` advertises a `costMultiplier` for the cost-aware rate limiter to
  consume; this module does not rewire that limiter. `CHALLENGE` and `SUSPEND`
  are what the request path enforces.

## Appeals

- `POST /v1/abuse-signals/decisions/:id/appeal` — any authenticated caller,
  against their own action only. The subject is resolved from the verified
  principal, never from a path parameter, so nobody can appeal somebody else's
  action.
- At most two open appeals per subject, each with a 72-hour review SLA.
- Filing an appeal **pins** the escalation level. It does not lift the action.
  Immunity-by-appeal would be an abuse channel; blunting escalation is not.
- If nobody reviews an appeal, it expires at its SLA and the pin is released —
  no operator action needed.
- An authorised reviewer decides via `POST /v1/abuse-signals/appeals/:id/decision`.
  An empty reviewer identity is refused fail-closed.

## Disclosure

Two visibly different surfaces, built as separate DTOs:

- **Admin plane** (`AdminGuard` + `RolesGuard`) exposes the reason code, its
  version, severity, confidence, sample count and corroboration count. A
  reviewer cannot explain a decision without them.
- **Subject plane** exposes only the appellant's own appeal. No reason code, no
  severity, no heuristic. Publishing the heuristic would turn every appeal into
  free red-team feedback.
- **Public wire** (the `429`) is uniform: `RATE_LIMITED`, a generic message and
  a `Retry-After`. The same shape for a challenge, a suspension and an
  indeterminate read, so a client cannot probe the module by comparing denial
  shapes. Thresholds appear on no surface at all.

## Fail-closed rules

| Condition | Outcome |
|---|---|
| No verified subject | `INDETERMINATE` / `unattributed` |
| Missing or partial release binding | `INDETERMINATE` / `release_binding_invalid` |
| Store read or write failure | `INDETERMINATE` / `store_unavailable` |
| Enforcement read indeterminate, attributable subject | **denied** with a bounded `Retry-After` |
| Enforcement read indeterminate, unattributable request | allowed (actions are keyed by subject, so "no subject" provably means "no action") |
| Malformed configured value | startup aborts |
| Salt missing or too short | no subject is ever attributable |

The unattributable-request exception is the one place that does not deny. It is
a proof, not a guess, and it keeps a store outage from becoming a denial of all
anonymous traffic.

## Release provenance

Every decision and action is stamped with the same chain / release /
deployment-block / artifact-checksum binding the finalized indexer cursor uses
— read through `loadFinalizedCursorConfig`, so there is exactly one definition
of a valid binding in the codebase. An action issued under a different binding
is ignored even if its expiry has not passed, so a decision can never be
replayed across deployments.

## Recovery

Everything here recovers without operator action:

- **Action expired** — enforcement stops; `expireActions()` records the status
  so the end of a bound is visible rather than inferred.
- **Window rolled over** — counters reset; escalation only counts earlier
  windows, so a subject restarts at the base action rather than at a permanently
  grown one.
- **Appeal SLA elapsed** — the pin is released.
- **Release binding changed** — in-force actions stop matching and stop applying.
- **Store unavailable while observing** — the sample is dropped and the response
  is untouched. Detection must never become an availability problem.
- **Store unavailable while enforcing** — denied, fail closed.

## Operational notes

- The default store and appeal register are **in-process and bounded**. This is
  what lets the module ship with no new external dependency. Running more than
  one replica with enforcement enabled requires binding a shared implementation
  to `ABUSE_SIGNAL_STORE` and `ABUSE_APPEAL_REGISTER`; the interfaces above
  them do not change, and decision ids are derived so a shared store dedupes
  across replicas.
- Rotating `ABUSE_SIGNALS_SUBJECT_SALT` invalidates existing subject keys.
  In-flight actions stop matching their subject and expire naturally. There is
  no sudden denial; expect decisions to look "orphaned" until they expire.
- `ABUSE_SIGNALS_TRUSTED_PROXY_HOPS` must match the real proxy topology. Set it
  too high and clients can forge their egress; too low and a whole CDN shares
  one budget.
- `abuse_decisions` and `abuse_appeals` are operational evidence. Nothing in
  the protocol path reads them.

## Testing

```
npx jest src/abuse-signals
```

Required categories from the issue and where they are covered:

| Category | Spec |
|---|---|
| False-positive fixtures | `fixtures/abuse-observations.fixtures.ts`, `abuse-signal.service.spec.ts` |
| Distributed sources | `abuse-signal.service.spec.ts` (replica convergence, shared counters, cross-subject credential spread) |
| Shared NAT | `abuse-subject.spec.ts`, `abuse-signal.service.spec.ts` |
| Attacker-controlled identifiers | `abuse-subject.spec.ts`, `abuse-signal.service.spec.ts` |
| Model/config version | `abuse-signal.service.spec.ts`, `abuse-signals.config.spec.ts` |
| Recovery | `abuse-signal.service.spec.ts`, `abuse-appeal.service.spec.ts` |
| Bounded / time-limited actions | `abuse-signal.service.spec.ts` |
| No protocol authority | `abuse-authority.spec.ts` |
| No public disclosure | `abuse-signal.interceptor.spec.ts`, `abuse-signals.controller.spec.ts` |