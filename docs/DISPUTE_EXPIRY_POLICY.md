# Dispute expiry authority

Issue #868 takes the **retire local expiry** option. The API must not infer a
terminal dispute outcome from `createdAt`, elapsed wall-clock time, or an operator
request. The canonical contract lifecycle owns expiry; `DisputeExpired` is
projected by `DisputesProjectorService` into the V2 dispute read model.

Passing a projected deadline can close appeal availability. It does not establish
expiry, refund a bond, or overwrite an existing resolved outcome. Consumers must
inspect chain finality and provenance separately from dispute lifecycle phase;
an observed terminal event is not proof of finalized chain state.

## Removed legacy behavior

- Removed `MAX_DISPUTE_DURATION_HOURS` and its arbitrary 72-hour default.
- Removed the age-based candidate query and terminal expiry write. Issue #865
  retains `expireDispute()` only as a throwing compatibility method;
  `getExpiredDisputes()` reads finalized events and never infers expiry from age.
- Retained `GET /disputes/expired` as an explicitly deprecated HTTP 410 response
  for deployments that still mount `DisputeModule`. It returns
  `LOCAL_DISPUTE_EXPIRY_RETIRED` and points clients to
  `/api/v2/dispute-read-models?status=expired`. The replacement has a versioned,
  paginated response with provenance/freshness metadata, not the legacy array.
- The default `AppModule` mounts `V2DisputesModule` and `DisputeReadModelsModule`.
  Issue #865 also mounts the replacement `DisputeModule` for separate review
  workflows and finalized projections, without registering the legacy entity.

No local expiry worker is registered. Accordingly, local worker locking, retry,
candidate-age rechecks, expiry metrics, and worker failure audit records are not
applicable: there is no local expiry write to coordinate or retry. Canonical event
ingestion, projection, replay, and their existing operational controls remain the
path for processing chain expiry. A stale or unavailable projection must not be
replaced with a local timer or a fabricated terminal state.

## Compatibility and dependencies

No schema or persisted status changes are introduced. Existing legacy rows are
not backfilled from their age or matched to canonical disputes by guesswork.
This removes the undeclared status reference described in #867 without adding a
new terminal status. The broader legacy command authority work in #865 and
persistence reconciliation in #831 remain separate; this change does not claim to
complete those issues or repair canonical projector finality/reorg limitations.

## Verification

`dispute.controller.spec.ts` covers the retired endpoint and verifies that it
does not call the legacy repository service. `dispute-expiry-retirement.spec.ts`
checks removal of the local expiry surface, canonical module bootstrap wiring,
and clock-independent terminal outcomes, including repeated reads and elapsed
deadlines. Existing V2 projector/read-model tests cover the canonical path.

Run the focused regression suite with:

```sh
npm test -- --runInBand src/dispute/dispute.controller.spec.ts src/dispute/dispute-expiry-retirement.spec.ts src/v2/disputes/read-models/dispute-read-model.service.spec.ts
```
