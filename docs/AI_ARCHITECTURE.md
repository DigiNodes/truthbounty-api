# AI Architecture

The active `AiAssistantModule` serves `/ai/conversations` through
`services/AiAssistantService`, `services/RagService`,
`services/SafetyGuardrailService` and `services/LlmProviderService`.
Issue #817 retains this path while consolidating unused duplicate implementations.

For paid chat and embedding requests, `LlmProviderService` calls
`AiBudgetService` before the SDK. The budget service uses the existing global
TypeORM PostgreSQL datasource registered by `DatabaseModule`; it creates no
additional connection. Conversation/message/RAG persistence remains at its
existing transitional boundary tracked by the maintainer's persistence recovery.

```text
authenticated conversation owner
  safety check and existing history/RAG prompt
  reserve selected provider/model allowance in PostgreSQL
    lock authority, then read database time
    validate policy, historical coverage and immutable price version
    check user + provider + global windows
  one SDK request with automatic retries disabled
  reconcile reservation and append AiUsageLog in one transaction
  save assistant response and return actual/held usage metadata
```

A single transaction locks `ai_budget_authority` for admission, reconciliation,
policy/price activation and override mutation. Network activity occurs after the
reservation commits. All replicas count the same durable attempts and usage
records across policy revisions. Window boundaries are UTC calendar days/months
assigned by admission time; changing a policy does not reset consumption.

Admission reserves the model's full verified input ceiling and existing output
allowance. It uses no client estimates or approximate tokenizer to authorize
spend. OpenAI chat reserves128000+16384 tokens; Anthropic chat reserves200000+1024;
the existing single-text embedding model reserves8192. Anthropic input spend
also reserves the maximum2x cache-creation tariff. Complete ordinary/cache-read
usage releases the unused allowance at the reservation's immutable price version.

Unknown usage, provider errors, process interruption and failed reconciliation
retain the full durable hold. There is no TTL refund. Actual usage above the bound
records a violation and halts new paid admission. SDK failures or accounting
failures never dispatch a fallback or another attempt. Mock responses have no
paid usage and require selecting the mock provider in a local or test environment,
or in development with `LOCAL_DEV_MODE=true`.

`ai_usage_logs` is the forward reconciliation source and is written through the
same transaction manager as the reservation outcome. The active Prisma usage
write is removed; its historical records/database remain intact. New fields keep
legacy prices and costs NULL rather than inventing zero or applying current rates.
The coverage checkpoint and longest-window drain prevent a new replica from
opening an empty allowance while earlier usage remains relevant in another store.

Only an authenticated user's own charged/uncertain day/month totals are returned
by `GET /ai/budgets/me`. Global/provider counters are internal. Administrative
operations require a verified `admin` role and membership in
`AI_BUDGET_OPERATOR_IDS`; user-only finite bonuses expire within24 hours and their
window. Existing `AdminAuditService.execute` commits the operation and success
audit together, retaining attempted/rollback/unknown outcomes.

The assistant remains advisory-only. Budget permissions do not authorize
contract actions, signing, fund transfers or protocol-state mutations. See
[operations](AI_ASSISTANT_OPERATIONS.md#durable-paid-provider-budgets) for cutover,
configuration, responses and rollback.
