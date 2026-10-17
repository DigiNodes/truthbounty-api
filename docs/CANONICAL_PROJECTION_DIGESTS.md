# Canonical Projection Digests & Cross-Environment Verification (PREWAVE-BE-039)

> **Scope.** Technical specification and operator guide for canonical projection digests, volatile field exclusions, deterministic row ordering, cross-environment comparability, and rebuild versus live comparison commands.

---

## 1. Overview & Problem Context

In event-sourced and projection-based architectures, projections in different environments (e.g., live production, shadow schemas, disaster recovery restores, or local testing nodes) can diverge in incidental ways while preserving semantic and canonical equivalence:
- **Insertion order**: Rows may be committed or queried in different orders without explicit primary key sorting.
- **Volatile fields**: Timestamps (`createdAt`, `updatedAt`, `syncedAt`) and auto-increment surrogate IDs (`internalId`, `__v`) reflect local wall-clock time and node-local sequences rather than canonical chain state.
- **Timezone formatting**: Timestamps representing the identical instant may be formatted in UTC (`Z`), localized timezone offsets (`+01:00`), or varying millisecond precisions.
- **Numeric representation**: Fixed-point decimal database types (e.g. `DECIMAL(18, 4)`) return trailing zeroes (`100.00` vs `100`), or numbers in scientific notation.
- **Null vs omitted properties**: Optional attributes may be omitted or stored as explicit `null`.

Without canonical normalization, projection digests drift across environments, making automated verification, disaster recovery audits, and cutover authorization unreliable.

**PREWAVE-BE-039** establishes strict canonical normalization and cross-environment comparability for all projection digests.

---

## 2. Technical Scope & Architecture

### 2.1 Canonical Serialization & Row Ordering
- **Canonical Serialization**: Compliant with RFC 8785 (JSON Canonicalization Scheme). Object keys are sorted lexicographically by UTF-16 code units, whitespace is removed, and non-finite numbers (`NaN`, `Infinity`) are rejected fail-closed.
- **Row Ordering**: Projection rows are individually canonicalized and sorted deterministically using UTF-16 code unit ordering (`a < b ? -1 : a > b ? 1 : 0`).
- **Scalable Streaming Hashing**: Rows are streamed sequentially through SHA-256 with memory bounds, supporting 10,000+ rows without out-of-memory errors.

### 2.2 Volatile Field Exclusion
The following fields are excluded by default from the canonical digest calculation:
- `created_at`, `updated_at`, `createdAt`, `updatedAt`
- `synced_at`, `syncedAt`, `rebuilt_at`, `rebuiltAt`, `indexed_at`, `indexedAt`
- `_rev`, `__v`, `internal_id`, `internalId`, `row_id`, `rowId`

Custom projector adapters can register additional volatile fields via `context.excludedFields`.

### 2.3 Timezone & Numeric Normalization
- **Timezones**: Any ISO 8601 timestamp string or `Date` object representing the same instant in time is canonicalized to UTC ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- **Numeric Precision**:
  - `-0` is normalized to `0`.
  - BigInt values are converted to standard strings.
  - Standard decimal strings strip redundant trailing fractional zeroes (`"100.00"` -> `"100"`, `"100.50"` -> `"100.5"`).
  - String identifiers with leading zeroes (e.g. `"007"`, `"0x123"`) are strictly preserved.

### 2.4 Cryptographic Envelope Binding
Each `ProjectionDigest` includes:
- `digest`: SHA-256 hex of the canonical rows (cross-environment comparable across rebuild schema and live schema).
- `envelopeDigest`: Composite SHA-256 binding:
  ```json
  {
    "artifactChecksum": "0x...",
    "canonicalVersion": "v1",
    "chainId": 11155420,
    "dataDigest": "<digest>",
    "deploymentBlock": 12000,
    "projector": "claims",
    "releaseId": "v2.1.0",
    "rowCount": 100,
    "schema": "replay_shadow"
  }
  ```
- `metadata`: Full audit payload containing algorithm, version, excluded fields, row count, and identities.

---

## 3. Typed Actionable Errors

When digests are compared or validated during cutover, discrepancies fail closed with typed actionable errors:

1. **`MissingProjectionDigestError` (`MISSING_PROJECTION_DIGEST`)**:
   - Thrown when a projector present in live is missing in rebuild or vice-versa.
   - Provides clear remediation guidance: *"Projector 'claims' exists in live schema 'public' but is missing in rebuild schema 'replay_shadow'. Rebuild is incomplete. Ensure 'claims' is rebuilt before cutover."*

2. **`ProjectionDigestMismatchError` (`PROJECTION_DIGEST_MISMATCH`)**:
   - Thrown when canonical row data has drifted between rebuild and live.
   - Identifies the mismatched projector, expected digest, received digest, and row counts.

3. **`ProjectionBindingMismatchError` (`PROJECTION_BINDING_MISMATCH`)**:
   - Thrown when chain ID or release ID drifts between compared environments.

---

## 4. CLI Compare Commands

### 4.1 Dedicated Projection Compare CLI
Use `ts-node src/scripts/projection-compare.ts` or `npm run projection:compare`:

```bash
# Compare rebuild report against live report (pretty output)
npm run projection:compare -- --rebuild rebuild-report.json --live live-report.json

# Compare with machine-readable JSON output
npm run projection:compare -- --rebuild rebuild-report.json --live live-report.json --format json

# Allow extra projectors in rebuild without failing
npm run projection:compare -- --rebuild rebuild-report.json --live live-report.json --allow-extra

# Skip chain/release binding verification
npm run projection:compare -- --rebuild rebuild-report.json --live live-report.json --no-binding-check
```

### 4.2 Rebuild CLI Compare Mode
`ts-node src/scripts/projection-rebuild.ts` supports `--mode compare`:

```bash
ts-node src/scripts/projection-rebuild.ts \
  --mode compare \
  --targetSchema replay_shadow \
  --expectedDigestsFile live-digests.json
```

---

## 5. Security & Invariants

- **Authoritative Source**: Canonical smart contracts and finalized events remain the sole authority.
- **Fail Closed**: Any missing digest, chain ID mismatch, or unverified cutover aborts execution immediately.
- **Secret Hygiene**: Projection digests and comparison reports never include private keys, credentials, or authentication tokens.
- **Auditability**: All comparison and rebuild reports conform to schema version 1 and are byte-for-byte reproducible.
