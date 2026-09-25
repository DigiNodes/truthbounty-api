# Operations Runbook: API Incident Response

> **Authority boundary (non-negotiable, applies to every section below).** Smart
> contracts and finalized canonical events are strictly authoritative. During an
> incident the API indexes, relays, and serves — it never decides. If the only
> way to make an endpoint return something is to invent it, the correct outcome
> is a `503` with a reason, not a plausible-looking response. See
> [§7 Chain-derived state during an incident](#7-chain-derived-state-during-an-incident).

**What this runbook is.** The procedure for declaring, running, escalating and
closing an incident against the TruthBounty V2 API, written against the
endpoints, modules, roles and configuration that actually exist in this
repository.

**What it is not.** It does not repeat
[DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) (recovery objectives, artifact
validation, shadow rebuild, indexer bootstrap, reorg response, snapshot
restore). It does not repeat [docs/indexer-runbook.md](../indexer-runbook.md)
(indexer signals, alert thresholds, replay semantics) or
[runbooks/outbox-notification-delivery.md](outbox-notification-delivery.md)
(outbox metrics, dead-letter replay). Those remain the authority for their
subjects; this document tells you what to *do* while an incident is open.

---

## 1. Severity classification

Severity is set at declaration and may be raised at any time. It is recorded on
the incident record as `IncidentSeverity` (`src/admin/entities/incident.entity.ts`)
and is filterable via `GET /admin/incidents?severity=...`.

The `critical | high | medium | low` enum is real. The **response times below are
a proposed baseline, not a measured one** — they are derived from the existing
RTO in [DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) (`< 4 hours` from
incident declaration) and the existing escalation rule in
[docs/indexer-runbook.md](../indexer-runbook.md) ("escalate if lag persists beyond
30 minutes"). They have not been validated against real incident data, and a
maintainer should revise them once there is. Replace them with real numbers when
there are real numbers; do not treat them as already calibrated.

| Severity | Definition — pick the first that matches | Acknowledge | IC assigned | First status update | All-clear target |
| -------- | ---------------------------------------- | ----------- | ----------- | ------------------ | ---------------- |
| **SEV1 `critical`** | Any of: the API is returning **fabricated or wrong protocol state**; `/health/ready` is failing on a critical dependency in production; a credential or signing key is suspected exposed; canonical event ingest is quarantining or dropping a large share of logs; a destructive migration is live in production. | 5 minutes | 15 minutes | 30 minutes, then hourly | ≤ 4 h (aligns with the documented RTO) |
| **SEV2 `high`** | Degraded but not wrong: projection lag above threshold and climbing; RPC failure rate in window above threshold; dead letters accumulating; notification/outbox backlog above threshold; one non-critical dependency down while the service still serves. | 15 minutes | 30 minutes | 60 minutes, then every 2 h | ≤ 8 h |
| **SEV3 `medium`** | Contained degradation with a workaround: a single endpoint degraded, a single contract's decoding quarantined, a non-production environment affected, or an alert with no user-visible impact. | 1 hour | 4 hours | Next business day | ≤ 2 business days |
| **SEV4 `low`** | Cosmetic, monitoring/config drift, or documentation/behavioural defect with no operational impact. | 4 hours | Next business day | Weekly digest | Next release |

**Escalate one level immediately** if, at any point during the incident:

- a SEV2/SEV3 turns out to have been **serving wrong data**, not just failing;
- `GET /health/indexer` reports `unhealthy` (missing head/finalized cursors — the
  readiness check fails closed on this);
- `POST /admin/protocol/emergency` was used with `emergency_shutdown` or
  `suspend_all_services`;
- a quarantined event (`v2_event_quarantine`) is found to correspond to a
  settlement-, reward-, governance-, claim- or dispute-relevant event;
- the blast radius cannot be bounded within the current severity's time budget.

---

## 2. Declaration

### 2.1 Who may declare

`IncidentController` (`src/admin/incidents/incident.controller.ts`) is guarded by
`AdminGuard` + `RolesGuard` with `@ApiBearerAuth()`. Creating an incident
requires `SUPER_ADMIN`, `ADMINISTRATOR`, or `SECURITY_ANALYST`:

```
@Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.SECURITY_ANALYST)
```

Reading incidents additionally admits `MODERATOR` and `AUDITOR`. The role
hierarchy used by the guards is in `src/admin/entities/admin.entity.ts`:

| Role | Hierarchy |
| ---- | --------- |
| `SUPER_ADMIN` | 100 |
| `ADMINISTRATOR` | 80 |
| `SECURITY_ANALYST` | 60 |
| `GOVERNANCE_OPERATOR` | 60 |
| `MODERATOR` | 50 |
| `AUDITOR` | 30 |

**Anyone may *raise* an incident** by paging the on-call. Declaring requires one
of the three roles above; if none is reachable, the on-call DevOps lead
coordinates with the Protocol Engineering team per
[DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md) and the incident is backfilled
into the record as soon as a qualifying admin is reachable. Backfilling is
recorded honestly as backfilled; it is not backdated.

### 2.2 Opening the record

```bash
curl -sS -X POST http://<api-host>:3000/admin/incidents \
  -H "Authorization: Bearer <admin-jwt>" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Indexer projection lag climbing past alert threshold",
    "description": "indexer_projection_lag_blocks has been above threshold for N minutes. /health/indexer reports degraded. No user-visible data change observed yet.",
    "classification": "system_failure",
    "severity": "high",
    "relatedEntityType": "blockchain",
    "relatedEntityId": "<chainId:contractAddress>"
  }'
```

`classification` must be one of the real enum values in
`src/admin/entities/incident.entity.ts`:

`security_breach` · `suspicious_activity` · `abuse_report` · `system_failure` ·
`governance_issue` · `policy_violation` · `other`

The record is created with `status: OPEN` and an audit entry is written through
`AuditTrailService`. **Never paste credentials, raw tokens, private keys, or
claim content into `description` or a note.** The outbox payload rules in
`src/outbox/outbox.service.ts` (routing identifiers only, no PII, no settlement
data) are the house standard for anything that gets written down during an
incident.

Use `classification: security_breach` for anything involving suspected key or
credential compromise, and follow [SECURITY.md](../../SECURITY.md) reporting
rules in parallel — the incident record is not a substitute for the disclosure
path, and the disclosure path is not a substitute for the incident record.

### 2.3 Assigning and escalating

```bash
# Move OPEN -> INVESTIGATING and take ownership
curl -sS -X POST http://<api-host>:3000/admin/incidents/<incident-id>/assign \
  -H "Authorization: Bearer <admin-jwt>" \
  -H 'Content-Type: application/json' \
  -d '{"assigneeId":"<admin-id>"}'

# Raise severity / classification mid-flight
curl -sS -X PATCH http://<api-host>:3000/admin/incidents/<incident-id> \
  -H "Authorization: Bearer <admin-jwt>" \
  -H 'Content-Type: application/json' \
  -d '{"severity":"critical"}'
```

`IncidentService.update` refuses updates once `status` is `CLOSED`
(`ForbiddenException: Cannot update a closed incident`) — a closed incident is
append-only in practice, so re-open by escalating before closing.

---

## 3. Roles during an incident

Three roles. For a SEV1/SEV2 all three are staffed by different people. For
SEV3/SEV4 one person may hold all three and say so in the record.

| Role | Held by | Owns | Must not |
| ---- | ------- | ---- | -------- |
| **Incident Commander (IC)** | The senior-most person on the incident: `SUPER_ADMIN` or `ADMINISTRATOR`; the on-call DevOps lead per [DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md). | Severity, the roll-back/roll-forward decision, escalation, the all-clear. Sole authority to enable maintenance mode or execute an emergency action. | Do the debugging hands-on. The IC's attention is coordination, not the terminal. |
| **Communications (comms)** | The next-most senior responder (`ADMINISTRATOR` or `SECURITY_ANALYST`); for a security incident, the one coordinating with the disclosure path. | Status updates on the cadence in §1, status-page text, stakeholder replies, the notification decision in §6. | Make technical changes. Comms relays the IC's decisions. |
| **Scribe** | Whoever is not yet fully loaded; rotates if the incident runs past the current severity's all-clear target. | The timeline. Every investigation note goes through `POST /admin/incidents/<id>/notes` **as it happens**, not reconstructed afterwards. | Investigate and communicate. One job. |

Two things the scribe must capture, because they are unrecoverable later: the
exact `GET /health`, `GET /health/ready`, `GET /health/indexer` and
`GET /metrics` output at the moment of declaration, and the exact image/tag and
migration state of what is deployed.

```bash
# Scribe's opening note — capture state, do not interpret it
curl -sS http://<api-host>:3000/health         | tee incident-<id>-health.json
curl -sS http://<api-host>:3000/health/ready   | tee incident-<id>-ready.json
curl -sS http://<api-host>:3000/health/indexer | tee incident-<id>-indexer.json
curl -sS -H "Authorization: Bearer <metrics-token>" \
        http://<api-host>:3000/metrics         > incident-<id>-metrics.prom
```

> `/metrics` is behind `MetricsAuthGuard` and needs a bearer token; the health
> endpoints are `@Public()`. Never paste the metrics token into an incident
> record, a ticket, or a chat channel.

---

## 4. The first 15 minutes

Ordered. Do not skip to step 5 because step 1 looks scary.

1. **Declare** (§2). If declaring is blocked on admin access, page and proceed;
   backfill the record.
2. **Confirm you are looking at the right thing.**
   ```bash
   curl -sS http://<api-host>:3000/health/live      # process up?
   curl -sS -o /dev/null -w '%{http_code}\n' \
        http://<api-host>:3000/health/ready          # 200 = ready, 503 = failing closed
   ```
   A `503` from `/health/ready` is **the system working correctly** — readiness
   fails closed when a critical dependency is unhealthy. Do not "fix" it by
   forcing readiness green.
3. **Read the dependency report.** `GET /health` returns per-dependency
   `status`, `responseTimeMs`, `lastSuccessfulCheck` and `failureReason` for
   `database`, `redis`, `queue`, `notifications`, `ipfs`, `blockchain`. The
   `failureReason` string is the fastest single pointer to the cause.
4. **Read the indexer snapshot.** `GET /health/indexer` — `status`,
   `observedHeadBlock`, `safeBlock`, `finalizedBlock`, `projectionHeadBlock`,
   `projectionLag`, `rpcFailureCount`, `replayCount`, `deadLetterCount`, plus the
   `alertThresholds` actually in force and a `runbookUrl`. `unhealthy` means
   required cursors are missing and readiness fails closed; see
   [docs/indexer-runbook.md](../indexer-runbook.md) for the remediation steps.
5. **Check whether the queue is backed up.** BullBoard is mounted at
   `/admin/queues`. `GET /admin/protocol/queues` (super_admin / administrator /
   security_analyst / auditor) returns per-queue metrics without opening the UI.
6. **Check the outbox and quarantine tables.** See §7 for the exact queries.
   Quarantine growth means logs are being held back, not processed.
7. **Confirm what is deployed and what the schema is.** The IC needs this before
   any roll-back decision:
   ```bash
   docker compose ps
   docker compose logs --tail=200 api
   npm run migration:run     # read-only in effect: reports applied vs pending
   ```
8. **Decide: contain, roll back, or roll forward.** Roll-back/roll-forward
   decision rule and procedure are in
   [runbooks/ROLLBACK_AND_RECOVERY.md](ROLLBACK_AND_RECOVERY.md) — do not
   improvise it here.
9. **Post the first status update** (§5) even if the cause is still unknown. "We
   are investigating, here is what we know, next update by <time>" is a valid
   update.
10. **Set the next-update time explicitly** and hold to it, including when there
    is no change. Silence is what turns SEV2 into SEV1.

---

## 5. Communication

### 5.1 Cadence

From §1. Post even when the update is "no change". Each update states: what is
known, what is not known, what is being done now, when the next update comes.

### 5.2 Templates

Fill the placeholders. Do not send a template with unfilled placeholders.

**Declaration**

```
[SEV<n>] TruthBounty API — <one-line symptom>

Started   : <UTC timestamp>
Status    : Investigating
Impact    : <what users experience; "degraded reads" / "no impact, monitoring">
Cause     : <known cause, or "under investigation">
Containment: <what is already done to limit blast radius, or "none yet">
Next update: <UTC timestamp>

Reference : incident <id>
```

**Update**

```
[SEV<n>] TruthBounty API — <id> — <status>

Elapsed   : <T+minutes>
Status    : Investigating | Identified | Monitoring | Resolved
Change    : <what is different since the last update>
Impact    : <current blast radius>
Action    : <what is being done right now>
Next update: <UTC timestamp>
```

**All-clear** — only after the verification checklist in
[runbooks/ROLLBACK_AND_RECOVERY.md](ROLLBACK_AND_RECOVERY.md#rollback-verification-checklist)
has been walked and the IC has said so explicitly.

```
[SEV<n>] TruthBounty API — <id> — Resolved

Resolved  : <UTC timestamp>
Duration  : <T+minutes> (all-clear target for SEV<n> was <target>)
Impact    : <final, cumulative>
Cause     : <one paragraph; the full analysis is the post-incident report>
Action    : <what was changed: config, code rollback, migration revert, etc.>
Verified  : <which checks were re-run and what they showed>
Follow-up : <postmortem date, ticket ids>
```

### 5.3 What must never appear in a status update

- Credential values, tokens, JWTs, private keys, SMTP passwords, RPC API keys.
- Real claim content, evidence payloads, or anything that identifies a reporter
  or verifier by wallet address.
- An all-clear that has not been verified. "It looks fine" is not a resolution.

If a secret was pasted into a status channel, treat it as a credential
compromise: rotate first, then write the postmortem.

---

## 6. Escalation and handoff

### 6.1 Escalation ladder

1. Responder on call → IC (as assigned in §3).
2. IC → Protocol Engineering team (named as the coordinating party in
   [DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md)) for anything touching event
   decoding, contract artifacts, finality, or projection correctness.
3. IC → repository maintainers, if a code or configuration fix is required and
   the release is not revertable in place.
4. IC → disclosure path per [SECURITY.md](../../SECURITY.md), for any
   `security_breach`, any suspected credential/key exposure, and any confirmed
   fabrication or corruption of protocol state.

Escalation is a status transition, not an accusation. Escalating early is never
penalised; sitting on a SEV2 that turns out to be a SEV1 is.

### 6.2 Handoff

Mandatory when any of these is true: the outgoing responder's shift ends; the
incident passes its all-clear target; or the IC changes.

Handoff contents, in this order, in a note on the incident record:

1. Incident id, severity, `status`, `assignedTo`.
2. Current status in one sentence.
3. Timeline to date (scribe's notes, referenced not re-typed).
4. What has been ruled out, and how — so the next person does not redo it.
5. Everything currently in flight: a revert mid-run, a paused queue, an
   enabled maintenance mode, an outstanding emergency action.
6. The exact next action, and who is doing it now.
7. The next-update time already promised externally.

The incoming IC confirms the handoff in the record before the outgoing responder
disconnects. Handoff of an incident is itself audited — `AuditTrailService` writes
an entry for note, assign, update, resolve and report actions.

### 6.3 Standing control state to check at handoff

Anything below left enabled is a latent outage for whoever comes next:

| Control | Endpoint | How to check |
| ------- | -------- | ------------ |
| Maintenance mode | `GET /admin/protocol/maintenance` | `active` flag, `reason`, `startedAt`, `scheduledEnd` |
| Active emergencies | `GET /admin/protocol/status` | `emergencyActive`, `activeEmergencies[]` |
| Paused queues | `GET /admin/protocol/queues` | per-queue `paused`, `waiting`, `active`, `failed` |
| Enabled throttling | `GET /admin/protocol/status` | `apiThrottlingActive` |

`GET /admin/protocol/status` returns `maintenanceMode`, `emergencyActive`,
`activeEmergencies`, `queuesOperational`, `notificationsEnabled`,
`integrationsOperational`, `apiThrottlingActive`, `uptime`, `environment` in one
call. Read it at handoff and again before declaring all-clear.

---

## 7. Chain-derived state during an incident

**The invariant.** The API never fabricates protocol state. Not under pressure,
not to satisfy a dashboard, not to make an endpoint return 200. Canonical events
already stored and contracts already deployed are the record; a gap in the
indexer's view is reported as a gap.

This is the same boundary stated in [ARCHITECTURE.md](../../ARCHITECTURE.md)
("API layer indexes, validates, and relays user-signed intent; it is never
authoritative for settlement, rewards, or governance") and in
[DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md). During an incident it is
enforced, not just intended:

1. **Never hand-write, patch, or SQL-update a projection, a canonical event, a
   checkpoint, or a cursor** to make state look right. Projections are rebuildable
   from persisted events; a hand-edited projection is neither rebuildable nor
   auditable. If a projection is wrong, the fix is a fix to the projector and a
   replay — see [runbooks/ROLLBACK_AND_RECOVERY.md](ROLLBACK_AND_RECOVERY.md#5-indexer-and-projection-recovery).
2. **Never synthesize a response body** for a read endpoint when the underlying
   event is missing. A `503` with a reason is correct; an empty or plausible
   payload is a protocol lie.
3. **Unapproved contracts are never decoded.** `ArtifactRegistryService`
   (`src/v2/events/artifact-registry.service.ts`) resolves `null` for any
   `(chainId, contractAddress)` without a row in `v2_contract_artifacts` where
   `isApproved = true`, and its doc comment states it fails closed rather than
   falling back to a default or legacy ABI. `CanonicalEventsService.ingest` then
   quarantines the log with reason `unregistered_address`. **Do not "fix" a
   quarantine spike by registering an address you have not verified against a
   canonical artifact.** That converts a visible stop into a silent wrong decode.
4. **Undecodable logs are quarantined, not dropped and not force-decoded.**
   `v2_event_quarantine` records reason, the raw log, and a detail string.
   Reasons: `unregistered_address`, `unknown_signature`, `artifact_drift`,
   `decode_error`.
5. **Data state is explicit.** Projected entities carry `DataState`
   (`src/v2/common/data-state.enum.ts`): `observed` (seen, not yet below the safe
   height), `safe` (below `lastSafeBlock`), `finalized` (below
   `lastFinalizedBlock`). Do not report `observed` data as settled. A
   reorg-affected `observed` row is expected to be re-evaluated, not defended.
6. **Checkpoints and cursors are monotonic.** `CanonicalEventsService` advances
   `v2_event_checkpoints.lastSafeBlock` inside the same transaction as the event
   write and never moves it backward, so a cursor can never run ahead of the data
   it describes. Preserve that property in any recovery step; a hand-lowered
   cursor is what turns a reorg into data loss.

### 7.1 Quarantine and outbox inspection queries

```sql
-- Quarantine: what is being held back, and why
SELECT reason, COUNT(*) AS rows, MIN("quarantinedAt") AS oldest
FROM v2_event_quarantine
GROUP BY reason
ORDER BY rows DESC;

SELECT "contractAddress", "reason", COUNT(*) AS rows, MAX("blockNumber") AS newest_block
FROM v2_event_quarantine
GROUP BY "contractAddress", reason
ORDER BY rows DESC
LIMIT 20;

-- Canonical ingest progress per contract
SELECT "chainId", "contractAddress", "lastSafeBlock", "lastFinalizedBlock", "updatedAt"
FROM v2_event_checkpoints
ORDER BY "updatedAt" ASC;

-- Projector resumption cursors
SELECT "projectorName", "lastBlockNumber", "lastLogIndex", "updatedAt"
FROM v2_projector_cursors
ORDER BY "projectorName";
```

Read-only. If any of these needs a write to "fix" the symptom, stop and escalate
to the IC — that is a [§7](#7-chain-derived-state-during-an-incident) violation
regardless of severity.

---

## 8. Fail closed vs fail open, per dependency

`HealthService.runChecks` (`src/health/health.service.ts`) marks each dependency
`critical: true` or `false`. That flag is the fail-closed/fail-open decision, and
it is already implemented — the operator's job is to know which mode each
dependency is in and not to override it casually.

| Dependency | `critical` | On failure | `runChecks` result | Effect on `/health/ready` | Operator guidance |
| ---------- | ---------- | ---------- | ------------------ | ------------------------- | ----------------- |
| `database` (PostgreSQL via TypeORM) | **true** | `checkDatabase` throws if `dataSource.isInitialized` is false or `SELECT 1` fails | `unhealthy` | `ready: false`, HTTP 503 | Fail closed. Do not serve reads from cache to "stay up" — a stale-but-successful response is exactly the fabrication this runbook forbids. Escalate. |
| `queue` (`jobs-queue`, BullMQ) | **true** | `checkQueue` throws if `getJobCounts(...)` fails | `unhealthy` | `ready: false`, HTTP 503 | Fail closed. Note the health check is a *reachability* check, not a depth check: a healthy queue with a huge backlog still reports `healthy`. Judge backlog from `GET /admin/protocol/queues` and the outbox counters. |
| `blockchain` (chain state + indexer health) | **true** | `checkBlockchain` throws if `state.lastProcessedBlock` is not a number, **and** if `BlockchainStateService.getIndexerHealth().status === 'unhealthy'` | `unhealthy` | `ready: false`, HTTP 503 | Fail closed by design — the code comment says so. This is the correct behaviour when cursors are missing. Do not force it green. |
| `redis` | false | `checkRedis` throws if `isHealthy()` is false | `degraded` | still `ready: true` | **Fail open, deliberately.** `RedisService` is documented as degrading gracefully; `.env.example` states "The application will start even if Redis is unavailable (with warnings)". Caching is bypassed, reads go to the database. Correct during a Redis incident. |
| `notifications` | false | `checkNotifications` throws if `getMetrics().queueDepth > 1000` | `degraded` | still `ready: true` | Fail open. A full notification queue is a delivery-backlog problem, not a correctness problem. If you need to stop the backlog growing, `disable_notifications` (§9) stops new work at the source. |
| `ipfs` | false | `checkIpfs` throws if the upload does not return a CID | `degraded` | still `ready: true` | Fail open. Evidence upload is degraded; nothing that decides protocol state depends on it. |

**Two documented fail-open points inside Redis** — both deliberate, both worth
knowing before you touch them during an incident:

- `RedisService.setnx` returns `true` ("acquired") when Redis is unavailable or
  errors, with the in-code comment "allow execution when Redis is unavailable
  (fallback to DB)". The SETNX guard is a fast path, not the correctness
  boundary; `NotificationProcessor` has a second, database-backed guard
  (`DeliveryHistory.findByIdempotencyKey`) that is authoritative. So a Redis
  outage costs throughput and adds a duplicate-suppression DB read, and does not
  cause duplicate deliveries. Do not "fix" this by making `setnx` return `false`
  when Redis is down — that would suppress legitimate first deliveries.
- `createThrottlerStorage` in `src/app.module.ts` falls back from Redis to
  in-memory throttler storage when the Redis connection fails. **Consequence
  during a Redis incident: rate limits are enforced per-instance rather than
  cluster-wide, so effective limits weaken.** That is a real availability/security
  trade, not a free win. Consider `suspend_integrations` or
  `enable_api_throttling` (§9) if abuse is the reason you are there.

**`REDIS_ENABLED=false` short-circuits everything** — `RedisService.onModuleInit`
logs a warning and returns with no client, and `getStatus().enabled` reports
`false`. Useful for a controlled degradation; not a substitute for fixing Redis.

---

## 9. Operational controls during an incident

`ProtocolAdminController` (`src/admin/protocol/protocol-admin.controller.ts`),
guarded by `AdminGuard` + `RolesGuard`, `@ApiBearerAuth()`. All write
operations below require `SUPER_ADMIN` or `ADMINISTRATOR` and are audited.

```bash
# --- Inspect first (read ops: super_admin, administrator, security_analyst, auditor)
curl -sS http://<api-host>:3000/admin/protocol/status   -H "Authorization: Bearer <admin-jwt>"
curl -sS http://<api-host>:3000/admin/protocol/maintenance -H "Authorization: Bearer <admin-jwt>"
curl -sS http://<api-host>:3000/admin/protocol/queues   -H "Authorization: Bearer <admin-jwt>"

# --- Maintenance mode (super_admin, administrator)
# SetMaintenanceModeDto: { enabled: boolean (required), reason?: string, scheduledEnd?: ISO-8601 }
curl -sS -X POST http://<api-host>:3000/admin/protocol/maintenance \
  -H "Authorization: Bearer <admin-jwt>" -H 'Content-Type: application/json' \
  -d '{"enabled": true, "reason": "<incident id + one line>"}'

# --- Service control (super_admin, administrator)
# ControlServiceDto: { serviceType: ServiceType (required), action: QueueAction|ServiceAction
#                     (required), queueName?: string, reason?: string }
curl -sS -X POST http://<api-host>:3000/admin/protocol/services/control \
  -H "Authorization: Bearer <admin-jwt>" -H 'Content-Type: application/json' \
  -d '{"serviceType":"<serviceType>","action":"<action>","reason":"<incident id>"}'

# --- Replay failed queue jobs (super_admin, administrator)
curl -sS -X POST "http://<api-host>:3000/admin/protocol/queues/retry-failed?queueName=<queue>" \
  -H "Authorization: Bearer <admin-jwt>"

# --- Emergency action (super_admin, administrator)
curl -sS -X POST http://<api-host>:3000/admin/protocol/emergency \
  -H "Authorization: Bearer <admin-jwt>" -H 'Content-Type: application/json' \
  -d '{"action":"<action>","reason":"<incident id + one line>","durationMinutes":30}'

# --- Resolve an emergency action when it is no longer needed
curl -sS -X POST http://<api-host>:3000/admin/protocol/emergency/<action>/resolve \
  -H "Authorization: Bearer <admin-jwt>"

# --- Cancel a scheduled maintenance window
curl -sS -X DELETE http://<api-host>:3000/admin/protocol/maintenance/schedule/<scheduleId> \
  -H "Authorization: Bearer <admin-jwt>"
```

`EmergencyAction` values, exactly as declared in
`src/admin/protocol/dto/emergency.dto.ts`:

| Action | Use during an incident | Watch out |
| ------ | ---------------------- | --------- |
| `suspend_all_services` | SEV1 where partial operation is worse than none. | Effectively a self-inflicted outage. Requires IC sign-off and a scheduled resolution. |
| `disable_notifications` | Notification/outbox backlog is compounding and competing for the same resources. | Users stop hearing from the API at all — including about the incident. Coordinate with comms before use. |
| `pause_all_queues` | Stop consuming while you fix the consumer, to stop a bad state spreading. | `PENDING` outbox rows keep accumulating; pair with a reprocessing plan. |
| `enable_api_throttling` | Abuse/load is the incident; you need to shed load. | Affects legitimate users too. Set the limits deliberately, not by default. |
| `suspend_integrations` | A dependency (webhook, SMTP, IPFS) is amplifying the failure. | Broad. Verify which integrations it actually covers before relying on it. |
| `emergency_shutdown` | Last resort, SEV1 only. | Stops the process. `/health/live` starts failing. Treat any use as an automatic severity escalation (§1) and confirm the recovery procedure in [DISASTER_RECOVERY.md](../DISASTER_RECOVERY.md). |

`reason` is required and should carry the incident id. `durationMinutes` is
optional and makes time-bound actions self-expire — prefer it over
remembering to resolve manually.

**The `action` values accepted by `/admin/protocol/services/control`** are the
union of two enums in `src/admin/protocol/dto/service-control.dto.ts`, and the
request body's field is `serviceType`, not `service`:

| `ServiceType` (`serviceType`) | `QueueAction` (`action`, queue-scoped) | `ServiceAction` (`action`, service-scoped) |
| --- | --- | --- |
| `queue` · `notification` · `webhook` · `cache` · `blockchain_indexer` · `background_processor` · `scheduled_job` | `pause` · `resume` · `clear` · `retry_failed` | `suspend` · `restore` · `restart` · `invalidate_cache` |

`queueName` is only meaningful when `serviceType` is `queue`.
`clear` and `retry_failed` are destructive or replay-triggering: they are
covered by the roll-forward rules in
[runbooks/ROLLBACK_AND_RECOVERY.md](ROLLBACK_AND_RECOVERY.md#when-rollback-is-not-safe-roll-forward-is-required).

**These controls change serving behaviour, not protocol state.** None of them
makes the API authoritative for anything. If an incident can only be "resolved"
by a control that alters settlement, rewards, treasury, governance, claim or
dispute state, that is a different class of incident and it escalates straight to
the disclosure path.

---

## 10. Post-incident review

### 10.1 Order of operations

1. **Do not close first.** The incident record is closed after the
   post-incident report exists, not before.
2. **Scribe reconstructs the timeline** from the investigation notes, the
   Prometheus series for the window, and the audit trail — before anyone
   refreshes their memory in the room.
3. **Post-incident report is written to the incident record:**
   ```bash
   curl -sS -X POST http://<api-host>:3000/admin/incidents/<incident-id>/report \
     -H "Authorization: Bearer <super-admin-jwt>" \
     -H 'Content-Type: application/json' \
     -d '{
       "rootCause": "<what actually caused it, mechanically>",
       "impact": "<duration, affected surfaces, who was affected, what data was or was not affected>",
       "preventiveActions": ["<action>", "<action>"],
       "lessonsLearned": ["<lesson>", "<lesson>"]
     }'
   ```
   These four fields are the real `PostIncidentReportDto` shape
   (`src/admin/dto/incident.dto.ts`) and they are the machine-readable record.
4. **Resolve, then close.** `POST /admin/incidents/<id>/resolve` takes
   `{ "summary": "...", "actions": ["..."] }` and sets `resolvedAt` plus
   `status: RESOLVED`. `IncidentService.update` then refuses further changes
   once `status` is `CLOSED`.
5. **File follow-ups as issues**, with the incident id in the description. A
   preventive action with no owner and no issue is a wish.
6. **Feed the back into the runbooks.** If this incident exercised a step that
   was missing, wrong, or ambiguous here, fix the document in the same change
   that closes the follow-up. This document, [docs/indexer-runbook.md](../indexer-runbook.md),
   [runbooks/ROLLBACK_AND_RECOVERY.md](ROLLBACK_AND_RECOVERY.md),
   [runbooks/PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) and
   [runbooks/outbox-notification-delivery.md](outbox-notification-delivery.md)
   are the operational surface, and they are only useful if they are corrected
   while the memory is fresh.

`GET /admin/incidents/stats/summary` returns `total`, `open`, `investigating`,
`resolved`, `closed`, `bySeverity`, `byClassification` and
`avgResolutionTimeHours` — the input for revisiting the severity table in §1 once
there is enough real data to calibrate it. Until then those numbers are the
proposed baseline, not a measurement.

> **Known routing hazard, flagged by reading the controller.** In
> `IncidentController` the `@Get('stats/summary')` handler is declared *after*
> `@Get(':id')`. Express matches in declaration order, so
> `GET /admin/incidents/stats/summary` can be captured by the `:id` handler and
> reach `findById('stats/summary')`, which then throws `NotFoundException`. This
> was **not** reproduced against a running server here. Until it is confirmed
> either way, read `avgResolutionTimeHours` from the database directly rather
> than relying on that route:
>
> ```sql
> SELECT status, severity, COUNT(*) AS n
> FROM incidents
> GROUP BY status, severity
> ORDER BY severity, status;
> ```
>
> Reordering the two route declarations is a one-line fix, but it is a source
> change and therefore outside the scope of this documentation issue. It should
> be filed as a follow-up.

### 10.2 Blameless postmortem template

Blameless means: no individual's name appears in a causal statement, and no
action is described as a mistake by a person. Roles and systems are named;
people are not. A blameless postmortem that names a person is not blameless, and
it suppresses exactly the reporting you need next time.

```markdown
# Postmortem — <incident title>

- Incident id      : <id>
- Severity         : SEV<n>
- Declared         : <UTC>          All-clear: <UTC>
- Duration         : <T+minutes>    Target for SEV<n>: <target from §1>
- IC               : <role, not name — or name, if the team prefers; be consistent>
- Comms / Scribe   : <roles>
- Chain state      : <was the API serving correct, degraded-but-correct, or wrong
                     protocol state at any point? Be specific. If wrong, this is
                     a security_breach-class finding and §6.1 step 4 applies.>
- Contracts touched: <none | list, with canonical artifact version>

## Summary
<Three to five sentences. What broke, what it affected, how it was resolved.
A reader who was not on the incident should be able to stop here and understand.>

## Timeline
<All times UTC. Scribe's notes, not reconstructed from memory.>

| Time (UTC) | Elapsed | Event | Source of truth |
| ---------- | ------- | ----- | --------------- |
|            | T+0     |       |                 |

## Detection
- How it was detected: <alert name / health endpoint / user report / manual>
- Time to detect: <minutes>          Time to declare: <minutes>
- Why that detection path: <what made this visible when it was>
- What did *not* detect it: <the gap>

## Impact
- Availability : <duration, % of requests or endpoints affected>
- Correctness  : <was any response wrong? which endpoints? how long?>
- Data         : <rows lost, rows quarantined, projections rebuilt, migrations run>
- Chain        : <reorgs, finality lag, projection lag, RPC failures — from /health/indexer and /metrics>
- Security      : <any exposure? rotated what, when?>

## Root cause
<Mechanism, not person. "The readiness check treats the BullMQ queue as critical,
so a Redis blip surfaced as a 503 on every endpoint" — not "the on-call did not
notice the alerts".>

## Contributing factors
- <factor>
- <factor>

## What went well
- <thing that limited blast radius or shortened the incident>
- Be specific. This section is what you want to read when the next one happens.

## Where we got lucky
- <the thing that could have been much worse and was not>

## Where we were slow
- <detection, escalation, or decision latency — no names>

## What was missing
- The step, signal, or control whose absence made this worse.
  Note here if it is already tracked by an incident id or issue.

## Action items
| Action | Type | Owner (role) | Issue | Due | Verification (how we will know it worked) |
| ------ | ---- | ------------ | ----- | --- | ---------------------------------------- |
|        | prevent / detect / mitigate / document | | | | |

## Runbook changes made
| Document | Section | What changed | PR |
| -------- | ------- | ------------ | --- |
|          |         |              |     |

## Notes for the severity table
- <any evidence bearing on the response times in §1 — this is how those numbers
  stop being a guess>
```

**The last section is not optional.** The severity table in §1 is a proposed
baseline. Every postmortem that produces evidence about detection or response
time should feed back into it, and the table should be revised — with the
revision dated — once there is enough data.

---

## 11. Change record

| Date | Author | Change |
| ---- | ------ | ------ |
| 2026-09-25 | `DevMuhdishaq (@DevMuhdishaq)` | Created for #501 (V2-BE-148). Every endpoint, module, enum, role and environment variable referenced here was read from the tree; response times in §1 are explicitly a proposed baseline pending real incident data. |

**Revision note.** First revision. This runbook was written by reading
`src/health/`, `src/admin/incidents/`, `src/admin/protocol/`, `src/redis/`,
`src/outbox/`, `src/v2/`, `src/app.module.ts` and the existing operations docs.
It has **not** been rehearsed against a live deployment, and no incident has been
run through it. Treat §1's timings, §4's ordering, and the templates in §5 as
proposals to be exercised in a game day and then corrected — that correction, and
this note, are what the first real incident should produce.
