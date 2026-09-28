# V2-BE-017 — Reward Allocation & Claim Audit

> **Scope.** V2-BE-017 asks for projection of the five reward-allocation
> beneficiary classes — submitter, verifier, challenger, treasury, refund —
> with claimable/claimed tracking and reconciliation against emitted source
> pools, **without** the backend deciding any outcome. The issue also requires
> the contributor to audit overlapping existing code first and state, per
> allocation kind, what was already projected.
>
> This document is that audit. It is the primary deliverable of the change,
> not an appendix to it.

---

## 1. Headline finding

**None of the five allocation kinds was projected anywhere in the repository
before this change.** The audit below is per-kind, but the summary is uniform:
there was no submitter allocation, no verifier allocation, no challenger
allocation, no treasury allocation, and no refund allocation in any read model.

What *did* exist was a **generic, allocation-blind** reward sync path
(`src/rewards/`) that records a whole distribution as an unordered
`recipients[]` / `amounts[]` pair. It cannot answer "how much is the treasury
owed", "how much has this verifier claimed", or "do the allocations reconcile
against the pool", because it never records a beneficiary *class*, never
records a per-beneficiary running total, and never records a pool to reconcile
against. So this is not a case of "the scope was already satisfied"; the
allocation projection is genuinely new.

---

## 2. Per-allocation-kind audit

Legend for the **Where** column: the file that projects the kind, if any.

| # | Allocation kind | Already projected before this change? | Where | Added by this change |
| - | --------------- | ------------------------------------ | ----- | -------------------- |
| 1 | **Submitter** | ❌ No | — | `src/v2/rewards/rewards-projector.service.ts` → `v2_project_reward_allocation`, `kind = 'submitter'` |
| 2 | **Verifier** | ❌ No | — | same projector, `kind = 'verifier'` |
| 3 | **Challenger** | ❌ No | — | same projector, `kind = 'challenger'` |
| 4 | **Treasury** | ❌ No | — | same projector, `kind = 'treasury'`, `beneficiary` recorded as `null` (a sink, not an EOA) |
| 5 | **Refund** | ❌ No | — | same projector, `kind = 'refund'` |
| + | **Source pool** (reconciliation anchor) | ❌ No | — | `ProjectRewardPool`, from `RewardPoolSettled` |
| + | **Claim progress** (claimable → claimed) | ⚠️ Partial, allocation-blind | `src/rewards/services/reward-sync.service.ts` | Rebuilt as a per-allocation running total; see §4 |

The five kinds are handled by **one** code path, not five. A beneficiary class
is a value read verbatim from the event's `kind` field; an event whose `kind` is
not one of the five is rejected and recorded as an indexing anomaly rather than
being coerced into a bucket. That is what keeps the five rows of the table above
honest — they are five *labels*, not five bespoke code paths to drift apart.

---

## 3. What already existed, and how it is treated here

### 3.1 Reused unchanged

| Path | Why it was reused |
| ---- | ----------------- |
| `src/v2/events/canonical-events.service.ts` | Ingestion + normalization + quarantine. Unchanged. The reward projector consumes its output rather than touching RPC or ABIs. |
| `src/v2/events/canonical-event-query.service.ts` | Deterministic `(blockNumber, logIndex)`-ordered reads. Unchanged. |
| `src/v2/events/event-schema-registry.ts` | **Appended to** — three new event names added. See §5. |
| `src/v2/common/entities/projector-cursor.entity.ts` | Per-projector resumption cursor. Unchanged; the reward projector uses the same upsert-per-event pattern as its three siblings. |
| `src/v2/common/entities/indexing-anomaly.entity.ts` | Shared anomaly log. Unchanged — the reward projector writes `out_of_order`, `duplicate_event`, and `invalid_transition` using the existing kinds rather than extending the enum. |
| `src/indexer/reorg-safe-cursor.service.ts` — *pattern only* | The "advance state and record the write atomically" idea. See §6. |
| `src/outbox/outbox.service.ts` | The deterministic-identity + explicit-terminal-state pattern. `RewardClaimed` is idempotent by construction. |

### 3.2 The projector pattern, copied not reinvented

`rewards-projector.service.ts` is a deliberate structural clone of
`disputes-projector.service.ts` and `verification-projector.service.ts`:

- same `processNewEvents(batchSize)` entry point and `ProjectorRunSummary`;
- same cursor read → `findAfter` → apply → cursor upsert loop;
- same `isUniqueViolation` check that recognises both Postgres `23505` and
  `SQLITE_CONSTRAINT` (so the fast in-memory integration test and production
  behave identically);
- same "replay vs. real duplicate" discrimination — on a unique violation, look
  the row up by `(eventTxHash, eventLogIndex)`; if it is there, it is a safe
  replay, otherwise it is a protocol-level fact worth an anomaly;
- same `readString` payload reader, same `recordAnomaly` swallow-on-duplicate.

This is intentional. Four projectors that share one shape are four fewer places
for a correctness argument to have to be re-derived.

### 3.3 Replaced / superseded — and what is *not* being deleted

| Legacy path | Status | Rationale |
| ----------- | ------ | --------- |
| `src/rewards/services/reward-sync.service.ts` | **Superseded, left in place** | It records whole distributions as `recipients[]`/`amounts[]` with no beneficiary class and no per-beneficiary total. The V2 projection is strictly richer. Removing it is a separate change with its own migration and its own consumers to check (`src/analytics/analytics.service.ts` reads `bounty`/`treasury` rows through a raw query path). |
| `src/rewards/entities/reward-claim.entity.ts` | **Superseded, left in place** | Same reason. It is also the only place in the repo that uses `decimal(78,0)` columns; the V2 tables use `varchar(100)` decimal strings to match every other V2 read model. |
| `src/rewards/entities/reward-distribution.entity.ts` | **Superseded, left in place** | Its `amounts: string[]` / `recipients: string[]` shape cannot express "treasury got 12%", only "this unordered set got these amounts". |
| `src/rewards/entities/reward.entity.ts` | **Dead code** | The file is literally `export class Reward {}`. See §6. |
| `src/rewards/rewards.service.ts` | **Dead code** | Returns the string `'This action returns all rewards'`. See §6. |
| `src/rewards/services/blockchain-listener.service.ts` | **Bypassed, left in place** | Polls `RewardClaimed`/`RewardDistributed` via `ethers` against `INDEXED_CONTRACTS`. Not wired to canonical events. |

**Nothing was deleted.** The issue asked for reused/replaced/deprecated to be
*identified in the pull request*, not for a teardown. Deleting the legacy paths
requires knowing their consumers, and that is a different, larger change.

### 3.4 Deprecated by this change, in the architectural sense

The **design** of the legacy distribution table is deprecated even though the
code is not removed:

- An unordered `amounts[]` array is deprecated in favour of one row per
  `(pool, kind, beneficiary)`. You cannot reconcile an array against a pool,
  and you cannot answer "how much has *this* beneficiary claimed".
- A claim total is deprecated in favour of a running `claimedAmount` per
  allocation, because a claim that cannot be attributed to an allocation must be
  refused rather than summed into a global figure that hides the unattributable
  one.

---

## 4. The one real semantic decision: refusing an over-claim

The projector **rejects** a `RewardClaimed` that would push an allocation's
`claimedAmount` above its `allocatedAmount`, records an
`invalid_transition` anomaly, and moves on. It does not record the claim.

This is the load-bearing decision in the whole change, so it is worth stating
plainly why:

- The alternative — recording it and letting `claimed > allocated` — would put
  a row in the read model asserting that more was claimed than the contract ever
  allocated. That is backend-authored protocol truth, which is precisely what
  this repository must never produce. A reader querying the API would have no
  way to tell a projected fact from an invented one.
- The alternative of *clamping* — recording `claimed = allocated` and dropping
  the excess — is worse: it silently discards a chain fact and makes the
  projection agree with itself while disagreeing with the chain.
- Rejecting keeps the invariant `claimed ≤ allocated` true in the table, and
  keeps the violation **visible** in `v2_indexing_anomalies`, where an operator
  will actually look.

A `RewardClaimed` that cannot be attributed to a known allocation is treated the
same way. The projector will not infer a beneficiary, because inferring one
means the backend deciding whose balance moved.

`rewards-reconciliation.service.ts` still *reports* an over-claim if one exists,
so a divergence arriving by any other route is loud rather than invisible. It
has no write path at all — it cannot correct anything.

---

## 5. Files added or changed for #354

### Added

| File | Purpose |
| ---- | ------- |
| `src/v2/rewards/reward-allocation-kind.enum.ts` | The five kinds + `parseAllocationKind`, which returns `null` for anything unrecognised. |
| `src/v2/rewards/entities/project-reward-allocation.entity.ts` | One row per emitted allocation. `allocatedAmount` verbatim, `claimedAmount` tracked. |
| `src/v2/rewards/entities/project-reward-pool.entity.ts` | The emitted pool total — the only thing allocations can be reconciled *against*. |
| `src/v2/rewards/reward-reconciliation.ts` | Pure `bigint` arithmetic. No clock, no DB, no network. |
| `src/v2/rewards/rewards-projector.service.ts` | The projector. |
| `src/v2/rewards/rewards-reconciliation.service.ts` | Read-side report. No write path. |
| `src/v2/rewards/v2-rewards.module.ts` | Module. **No controller** — see §7. |
| `src/v2/rewards/reward-reconciliation.spec.ts` | Pure unit tests. |
| `src/v2/rewards/rewards-projector.service.integration.spec.ts` | SQLite integration tests, modelled on `disputes-projector.service.integration.spec.ts`. |
| `src/migrations/1788100000000-CreateV2RewardAllocationTables.ts` | The two tables. |

### Modified

| File | Change | Why it was necessary |
| ---- | ------ | -------------------- |
| `src/v2/events/event-schema-registry.ts` | Appended `RewardPoolSettled`, `RewardAllocated`, `RewardClaimed` | Without a mapping, `EventDecoderService.normalize` returns `artifact_drift` and the events are **quarantined** — they would never reach `CanonicalEvent`, and the projector would have nothing to read. |
| `src/app.module.ts` | Registered `V2RewardsModule` | Otherwise the projector is never instantiated. |

---

## 6. Findings outside this issue's scope

Recorded here so they are not lost. **None of these was changed by this PR.**

1. **`src/rewards/entities/reward.entity.ts` is `export class Reward {}`.**
   Empty. Registered nowhere.
2. **`src/rewards/rewards.service.ts` returns placeholder strings**
   (`'This action returns all rewards'`). `RewardsService` is registered in
   `RewardsModule`, which `app.module.ts` imports, so it is live — and the
   endpoints behind it return strings, not data.
3. **`ClaimResolutionService.computeConfidenceScore` derives a verdict from
   vote weights and `resolveClaim` persists it**
   (`src/claims/claim-resolution.service.ts`). This is backend-authoritative
   settlement: the API decides `verdict` and `confidenceScore` from vote
   totals. Under the project's own stated invariant — the chain is the only
   authority for protocol truth — this is the single most significant
   contradiction found during this audit. It is **not** touched here; it needs
   its own issue, and removing it is a behavioural change, not a refactor.
4. **`src/health/health.service.ts` contains unresolved merge-conflict
   remnants** — bare expression statements ` feat/be-016-monitoring-api` and
   ` main` at lines 230, 241, 266 and 274 (and the same pattern in
   `health.service.spec.ts` at lines 88, 95, 106 and 112), introduced by commit
   `5d2af21 "Merge branch 'main' into feat/be-016-monitoring-api"`. These sit
   inside function bodies, so the files will not type-check cleanly. Pre-existing
   on `main`, unrelated to this work, and deliberately left alone — but it means
   `npm run build` / `npm test` may currently fail for reasons that have nothing
   to do with any open PR. **Check this before attributing a red build to this
   change.**
5. **`src/contracts/contract-artifacts.loader.ts` and
   `src/health/health-diagnostics.controller.ts` are dead code.** The loader
   `process.exit(1)`s when `config/contracts/release-artifacts.json` is missing,
   and that path is neither in the repository nor copied into the container
   image. Harmless only because neither is registered as a provider or
   controller in `src/app.module.ts`. If either is ever wired up, the
   production image will refuse to start. Cross-referenced in
   [`CONTAINER_IMAGE.md`](./CONTAINER_IMAGE.md) §5.
6. **`src/indexer/reorg-safe-cursor.service.ts` targets two tables that no
   migration creates** (`v2_indexer_cursors`, `v2_projections`). It is not
   registered anywhere. Cross-referenced in
   [`PROJECTION_REBUILD.md`](./PROJECTION_REBUILD.md) §7.

---

## 7. What this change deliberately does not do

- **No endpoint that writes, adjusts, or approves an allocation.** The module
  registers no controller. A `POST /rewards/...` that creates or changes an
  allocation would be exactly the backend-authoritative settlement this
  repository forbids. A read-only controller is a separate, additive change.
- **No `getTotalClaimedByWallet` shortcut across kinds.** The legacy
  `RewardClaimRepository.getTotalClaimedByWallet` sums claims globally. A
  per-kind, per-allocation report is provided instead, so a caller cannot
  mistake a refund for a verifier reward.
- **No recomputation of a stake share, a slashing ratio, or a split.** Every
  amount is either the event's `amount` or a `bigint` sum of amounts from events
  the contract emitted.
- **No floating point anywhere.** Amounts are `varchar(100)` decimal strings;
  all arithmetic is `bigint`. `reward-reconciliation.ts` throws on anything
  that is not a base-10 integer string, so a malformed amount surfaces as a
  defect instead of coercing to `0` — and `0` would read as "this beneficiary
  was allocated nothing", which is a materially different claim from "we could
  not read this event".

---

## 8. The one assumption flagged for review

Carried forward from every sibling projector, and stated in the same terms:

> **V2-BE-008 (approved artifact import) has not landed, so there is no frozen
> ABI to read real argument names from.** The payload keys read here — `kind`,
> `beneficiary`, `sourcePoolId`, `allocationId`, `poolId` — follow the
> vocabulary of the V2-BE-017 issue text and the convention documented in
> `src/v2/events/event-schema-registry.ts`. They are expected to be reconciled
> against the real approved ABI once V2-BE-008 exists. Nothing in this change
> alters protocol meaning: it only says where to look for each field's value in
> whatever the approved ABI turns out to expose.

The consequence to watch for: if the real ABI names these arguments
differently, the projector will reject events as `out_of_order` (rather than
mis-record them), the anomaly log will show it immediately, and the fix is a
rename in one registry plus one projector. That is the intended failure mode —
loud and cheap, not silent.

---

## 9. Verification status

**No install, build, lint, or test run was performed by the author of this
change.** The maintainer runs all of that. Nothing in this document should be
read as a claim that the code compiles, that the specs pass, or that the
migrations apply. Every count, row, and path above is derived by reading the
source, not by running it.
