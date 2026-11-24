# Administrative audit persistence

`AdminAuditService` stores administrative evidence in PostgreSQL through TypeORM.
Apply `PersistAdministrativeAudit1792200000000` before enabling callers. The
runtime and CLI currently discover different migration directories; the CLI file
re-exports the same migration. Do not enable both discovery paths together.

## Transaction boundary

Use `execute(context, async manager => ...)` for protected database operations.
Authorize the actor/capability first, then perform **every** domain write through
the supplied manager. The service commits an `attempted` record before calling
the operation, and inserts `success` in the operation's transaction. Audit insert
failure prevents that transaction from committing. A confirmed rollback gets a
separate `rolled_back` record; uncertain commit/rollback acknowledgement gets
`unknown`. If the database cannot accept the final failure record, the durable
attempt remains for reconciliation and the call rejects. Never interpret an
attempt alone as success. Callbacks must not commit/release the manager themselves.

External side effects cannot be rolled back by a database transaction. Use a
transactional outbox for them. Keep callbacks short; a locked singleton chain head
serializes audit appends. `log(input, manager)` supports an existing transaction
but rolls back with it; use the wrapper when durable attempt/failure evidence is
required. `logBatch` commits all records together. Correlation IDs group events,
including retries; they are not idempotency keys and do not suppress operations.

## Evidence and privacy

Supply opaque UUID references for actor, target, authority decision, request,
result and correlation. Capability and target type are reviewed codes, not free
text. The caller must resolve identity and authorization from trusted context;
the service does not grant permissions. Chain authority also requires chain ID,
release UUID, deployment block and artifact checksum. Raw payloads, headers,
metadata, reasons and error messages are deliberately excluded, even if extra
properties reach the service at runtime. This replaces the previous permissive
in-memory input contract; there are no production call sites at this revision.
Issue #595's future protected-operation interfaces must adopt this boundary.

Each row has an immutable event ID, timestamp, sequence, retention deadline and
SHA-256 chain link. Verification uses a consistent database snapshot and checks
the persisted head, including missing tails. This detects corruption; it is not
proof against a privileged administrator who can rewrite both rows and hashes.
Use restricted application credentials and separately protected backups/exports.

PostgreSQL triggers reject updates, deletes and truncation. There is no service
mutation or purge API. `ADMIN_AUDIT_RETENTION_DAYS` accepts integers 1–3650 and
defaults to 365. It records a minimum retention deadline, not an automatic deletion
schedule. Changing the setting does not rewrite existing records. The legacy
`audit_logs` retention job does not operate on this table. Any future archival or
purge design must preserve chain verification and receive separate review.

Migration rollback drops evidence: export it and obtain operator approval before
using `down` outside a disposable test database. PostgreSQL is required; SQLite
is intentionally unsupported for these guarantees.

## Verification and dependencies

Run the integration suite against a disposable PostgreSQL database:

```sh
ADMIN_AUDIT_TEST_DATABASE_URL=postgresql://localhost/audit_test npm test -- --runInBand test/admin-audit.postgres.spec.ts
```

The suite creates and removes its own random schema and validates migration
up/down/up, commits, rollback, concurrent appends, correlation grouping, privacy,
retention, immutable storage and unavailable persistence. Without the environment
variable the PostgreSQL suite is skipped, not counted as verified.

This implementation follows current CONTRIBUTING/PR requirements for TypeORM.
Open dependency #585 requests Prisma/PostgreSQL convergence instead; maintainers
must resolve that conflict before release. Dependencies #584 and #595 also remain
separate work. This change adds no protocol-authoritative mutation and does not
claim those prerequisites or future endpoint integration are complete.
