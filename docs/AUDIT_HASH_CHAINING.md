# Audit Stream Canonical Serialization and Hash Chaining

## 1. Problem Context and Technical Scope

Following Wave 9 audit reviews, security and administrative audit record integrity requires a distinct production-readiness boundary. While protocol contracts and finalized on-chain events remain authoritative, off-chain security and administrative operations require verifiable cryptographic tamper-detection.

This subsystem provides:
- **Canonical Serialization**: RFC 8785 compliant canonical JSON serialization guaranteeing cross-environment determinism.
- **Per-Stream Hash Chaining**: Partitioned append-only audit streams with keyed HMAC-SHA256 integrity hashes and previous-hash chaining.
- **Genesis & Checkpoint Invariants**: Explicit mathematical rules binding stream roots and checkpoints to release parameters.
- **Key Rotation**: Cryptographic verification across key boundaries with fail-closed key resolution.
- **CLI & Operational Commands**: Verification, checkpointing, secret-free export, and corruption-reporting commands.
- **Explicit Non-Goal**: **No claim of blockchain immutability**. Hash chaining guarantees internal structural consistency and tamper-evidence in append-only storage; it does not replace or emulate decentralized Byzantine consensus.

---

## 2. Immutability Boundary & Security Model

> [!IMPORTANT]
> **Append-Only Tamper Detection vs Blockchain Immutability**  
> Hash-chaining makes unauthorized additions, deletions, re-orderings, or field mutations immediately detectable upon verification. However, it does **not** claim decentralized blockchain immutability: a database administrator with direct storage access could re-write rows and regenerate hashes if they possess the HMAC secret. For true defense-in-depth:
> 1. HMAC secrets are stored outside the database (e.g. KMS / secret manager).
> 2. Database triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` operations on audit tables.
> 3. Checkpoints and secret-free exports are exported to external write-once storage.

---

## 3. Canonical Serialization (RFC 8785)

Deterministic verification across diverse platforms, operating systems, and JavaScript engine versions requires canonical serialization:

1. **Object Properties**: Sorted lexicographically by UTF-16 code units.
2. **Whitespace**: Completely eliminated outside of string literals.
3. **Number Representation**:
   - Rejects non-finite numbers (`NaN`, `Infinity`, `-Infinity`).
   - Standard decimal format without trailing zeros.
   - `-0` is canonically serialized as `0`.
4. **Dates**: Serialized as strict ISO 8601 UTC strings (`YYYY-MM-DDTHH:mm:ss.sssZ`).
5. **Arrays**: Elements retain position; `undefined` in arrays throws an immediate error to prevent ambiguous element spacing.
6. **Prototype Safety**: Keys `__proto__`, `constructor`, and `prototype` are stripped to prevent prototype pollution.

---

## 4. Per-Stream Hash Chaining Architecture

Audit records are partitioned by `streamId` (e.g., `admin_security`, `admin_governance`, `operations`). Each stream maintains independent sequence numbering and cryptographic chaining:

```
+------------------------------------------------------------------------+
| Genesis Hash: SHA-256(streamId, chainContext, GENESIS_TAG)              |
+------------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------------+
| Sequence 1: previousHash = Genesis Hash                                |
|   integrityHash = HMAC-SHA256(keyId_1, canonical(Record_1))           |
+------------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------------+
| Sequence 2: previousHash = Record_1.integrityHash                      |
|   integrityHash = HMAC-SHA256(keyId_1, canonical(Record_2))           |
+------------------------------------------------------------------------+
                               |   (Key Rotation to keyId_2)
                               v
+------------------------------------------------------------------------+
| Sequence 3: previousHash = Record_2.integrityHash                      |
|   integrityHash = HMAC-SHA256(keyId_2, canonical(Record_3))           |
+------------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------------+
| Checkpoint: Pinned sequence 3, headHash, timestamp, chainContext        |
|   checkpointHash = HMAC-SHA256(keyId_2, canonical(Checkpoint))         |
+------------------------------------------------------------------------+
```

### Authoritative Chain Binding

Every record and genesis anchor binds to authoritative deployment metadata:
```typescript
export interface AuditStreamBinding {
  chainId: number;          // e.g. 10 (OP Mainnet) or 11155420 (OP Sepolia)
  releaseId: string;        // UUID of release artifact
  deploymentBlock: string;  // Stringified block number
  artifactChecksum: string; // 0x-prefixed 32-byte sha256 checksum
}
```
If an audit record's `chainContext` does not match the authoritative deployment parameters, verification immediately fails closed (`BINDING_MISMATCH`).

---

## 5. Genesis and Checkpoint Rules

### Genesis Rule

For any stream `streamId` and release binding `B`:
$$\text{GenesisHash} = \text{SHA-256}(\text{Canonical}(\{ \text{binding}: B, \text{genesisTag}: \text{"TRUTHBOUNTY\_AUDIT\_STREAM\_GENESIS\_V1"}, \text{streamId} \}))$$

- Sequence 1 of any stream **must** have `previousHash === GenesisHash`.
- Distinct streams or release bindings produce distinct, non-colliding genesis roots.

### Checkpoint Rule

A checkpoint pins the verified state of a stream at sequence $N$:
```typescript
export interface AuditStreamCheckpoint {
  streamId: string;
  sequence: number;
  headHash: string;
  timestamp: string;
  chainContext: AuditStreamBinding;
  keyId: string;
  checkpointHash: string;
}
```

- Checkpoints can only be generated for streams whose records up to sequence $N$ pass verification.
- A checkpoint enables fast range verification and detects if historical records prior to sequence $N$ were modified or truncated.

---

## 6. Key Rotation Specification

To allow key retirement without invalidating historical chain verification:
1. Each record stores the `keyId` used to generate its `integrityHash`.
2. When rotating keys via `AuditKeyRegistry.rotateKey(newKeyId, newSecret)`:
   - Subsequent records are signed using `newKeyId`.
   - The `previousHash` chains to the prior record regardless of which key generated the prior record's hash.
3. Verification resolves `keyId` from the registry. If a record references an unknown or revoked `keyId`, verification fails closed (`KEY_UNKNOWN`).

---

## 7. Covered Record Mutations & Corruption Detection

The diagnostic engine (`AuditStreamService.diagnoseCorruption` / `corruption-report`) classifies mutations into 10 distinct categories:

| Corruption Type | Detection Mechanism |
| :--- | :--- |
| **`MUTATION`** | Record content altered; recomputed hash $\neq$ `integrityHash`. |
| **`DELETION_GAP`** | Record missing from stream; sequence gap $S_i > S_{i-1} + 1$. |
| **`DUPLICATE_SEQUENCE`** | Sequence number re-used in stream. |
| **`REORDER`** | Non-monotonic sequence progression ($S_i < S_{i-1}$). |
| **`INSERTION`** | Rogue record inserted; breaks sequence or `previousHash` link. |
| **`PREVIOUS_HASH_MISMATCH`** | Record's `previousHash` does not match preceding `integrityHash`. |
| **`HASH_TAMPER`** | `integrityHash` manually replaced with invalid digest. |
| **`KEY_UNKNOWN`** | `keyId` not registered in `AuditKeyRegistry`. |
| **`BINDING_MISMATCH`** | `chainContext` does not match authoritative release parameters. |
| **`CHECKPOINT_MISMATCH`** | Stream tip does not match published checkpoint. |

---

## 8. Export and Import (Secret-Free Evidence)

Audit streams can be exported for external compliance audits and offline verification:

```json
{
  "format": "truthbounty-audit-stream-export-v1",
  "streamId": "admin_security",
  "exportedAt": "2026-10-17T04:46:49.000Z",
  "chainContext": {
    "chainId": 11155420,
    "releaseId": "b7b2524a-1913-4f9e-a89c-4ec7a7183e20",
    "deploymentBlock": "12850400",
    "artifactChecksum": "0x3a7e58c97354a88f72c0587d5a3ef1806e5792949f506e938923058dbb239561"
  },
  "recordCount": 10,
  "fromSequence": 1,
  "toSequence": 10,
  "headHash": "0a1b2c...",
  "checkpoints": [...],
  "records": [...],
  "disclaimer": "Hash-chaining guarantees tamper-evidence... without claiming blockchain immutability."
}
```

### Privacy Guarantee
`AuditExportSanitizer` scans all exported data structures:
- **No secrets, tokens, or private keys**: HMAC secret keys, passwords, bearer tokens, or internal topologies are strictly rejected if present.
- Exports can be shared with auditors for independent verification using an auditor's registered HMAC key or public verification tool.

---

## 9. CLI Commands Guide

The CLI (`src/scripts/audit-chain.ts`) provides 4 primary commands:

### 1. Verify Stream
```bash
npm run audit:verify -- --stream admin_security
npm run audit:verify -- --in export.json --json
```

### 2. Checkpoint Stream
```bash
npm run audit:checkpoint -- --stream admin_security
```

### 3. Export Stream
```bash
npm run audit:export -- --stream admin_security --out stream-evidence.json
```

### 4. Corruption Diagnostic Report
```bash
npm run audit:corruption-report -- --stream admin_security
npm run audit:corruption-report -- --in suspicious-stream.json
```
