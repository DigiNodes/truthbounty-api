# Audit Stream Architecture Diagrams

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Application                             │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐    │
│  │                  Business Services                      │    │
│  │  (ClaimService, EvidenceService, RewardService, etc.)  │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       │                                        │
│                       │ Inject                                 │
│                       ▼                                        │
│  ┌────────────────────────────────────────────────────────┐    │
│  │            AuditStreamService                          │    │
│  │  • append(streamId, payload)                           │    │
│  │  • getHead, getRecord, createCheckpoint                │    │
│  │  • verifyChain, exportCheckpointForVerification         │    │
│  │                                                        │    │
│  │  Responsibilities:                                     │    │
│  │  - Sanitize payload (remove secrets)                  │    │
│  │  - Canonicalize JSON (sorted keys)                    │    │
│  │  - SHA256 hash payload                                │    │
│  │  - Sign with active key (HMAC-SHA256)                 │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       │                                        │
│                       ├──────────────┬──────────────┐          │
│                       ▼              ▼              ▼          │
│  ┌──────────────────────┐  ┌──────────────────┐  ┌────────────────┐
│  │ AuditStreamStore     │  │ AuditKeyRegistry │  │ DurableStore   │
│  │ (Abstract)           │  │ (Abstract)       │  │ (Concrete)     │
│  └──────────────────────┘  │                  │  └────────────────┘
│         ▲                   │ Implementation:  │        │
│         │                   │                  │        │
│  ┌──────┴─────────────────┐ │ SecretAuditKey  │        │
│  │                        │ │ Registry        │        │
│  │ ┌────────────────────┐ │ │                  │        │
│  │ │ DurableAuditStream │ │ │ • Load active   │        │
│  │ │ Store (Prod)       │ │ │   key from      │        │
│  │ │ • Database         │ │ │   secrets       │        │
│  │ │ • Transactions     │ │ │ • Rotate keys  │        │
│  │ │ • Unique           │ │ │ • Revoke       │        │
│  │ │   constraints      │ │ │                  │        │
│  │ └────────────────────┘ │ └──────────────────┘        │
│  │                        │        │                   │
│  │ ┌────────────────────┐ │        │                   │
│  │ │ InMemoryAuditStream│ │        │                   │
│  │ │ Store (Test)       │ │        │                   │
│  │ │ • Maps only        │ │        │                   │
│  │ │ • No persistence   │ │        │                   │
│  │ │ • Dev/test only    │ │        │                   │
│  │ └────────────────────┘ │        │                   │
│  └────────────────────────┘        │                   │
└─────────────────────────────────────┼───────────────────┘
                                      │
                        Conditional Injection:
                        NODE_ENV=production
                           → Durable
                        else
                           → InMemory
                                      │
                        ┌─────────────▼──────────────┐
                        │       Database             │
                        │                            │
                        │ • audit_stream_records    │
                        │ • audit_stream_checkpoints│
                        │ • audit_key_metadata      │
                        │                            │
                        │ Indexes:                   │
                        │ • (streamId, sequence)    │
                        │ • (streamId, createdAt)   │
                        │ • (streamId)              │
                        │ • (isActive)              │
                        └────────────────────────────┘

                        ┌─────────────────────────────┐
                        │    Secrets Manager          │
                        │                             │
                        │ AUDIT_ACTIVE_KEY_ID        │
                        │ AUDIT_HMAC_KEY_<keyId>     │
                        │                             │
                        │ (Never in app tables)       │
                        └─────────────────────────────┘
```

## Hash-Chain Data Structure

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Stream: "claim-123"                             │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Record 1                      Record 2                 Record 3      │
│  ┌────────────────────┐       ┌────────────────────┐  ┌──────────┐  │
│  │ streamId: "c123"   │       │ streamId: "c123"   │  │ streamId │  │
│  │ sequence: 1        │       │ sequence: 2        │  │ seq: 3   │  │
│  │ previousHash: "0"  │◄─────►│ previousHash: H1   │  │ prevH: H2│  │
│  │ payloadHash: H1    │       │ payloadHash: H2    │  │ payloadH │  │
│  │ hmacSignature: S1  │       │ hmacSignature: S2  │  │ hmacSig │  │
│  │ keyId: "key-24-01" │       │ keyId: "key-24-01" │  │ keyId   │  │
│  │ timestamp: T1      │       │ timestamp: T2      │  │ tstamp  │  │
│  │ createdAt: D1      │       │ createdAt: D2      │  │ created │  │
│  └────────────────────┘       └────────────────────┘  └──────────┘  │
│         │                             │                      │        │
│         │                             │                      │        │
│         └─────────────────────────────┴──────────────────────┘        │
│            Chain: Link via previousHash == priorRecord.payloadHash    │
│                  Breaks if any record is tampered                     │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

## Hash and Signature Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Append Request                                  │
│                                                                      │
│  streamId: "claim-123"                                               │
│  payload: {                                                          │
│    action: "CLAIM_UPDATED",                                          │
│    status: "VERIFIED",                                               │
│    amount: 100                                                       │
│  }                                                                   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 1. Sanitize (remove secrets)         │
        │    - Remove password*, secret*, token*│
        │    - Recursively sanitize nested obj │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 2. Canonicalize JSON                 │
        │    - Sort keys alphabetically        │
        │    - Deterministic string output     │
        │    Result: "{"action":"CLAIM_..."}"  │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 3. SHA256 Hash                       │
        │    SHA256("{"action":"CLAIM_..."}")  │
        │    Result: payloadHash = "abc123..." │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 4. Load Active Key Material          │
        │    Key ID: "key-2024-01"             │
        │    Material: (from secrets manager)  │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 5. HMAC-SHA256 Sign                  │
        │    HMAC(keyMaterial, payloadHash)    │
        │    Result: hmacSignature = "def456..."│
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 6. Get Previous Hash                 │
        │    If record 1: previousHash = "0"   │
        │    If record N: = prior.payloadHash  │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 7. Chain Continuity Check            │
        │    If previousHash != expected        │
        │      ➜ Throw "Chain continuity       │
        │      violation"                      │
        │    Else                              │
        │      ➜ Continue                      │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ 8. Transactional Insert              │
        │    INSERT INTO audit_stream_records  │
        │    (streamId, sequence, previousHash,│
        │     payloadHash, hmacSignature, keyId│
        │    )                                 │
        │    Unique constraint prevents dup    │
        └──────────────────────┬───────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────┐
        │ Result: AuditStreamAppendResult      │
        │ {                                    │
        │   streamId: "claim-123",             │
        │   sequence: 42,                      │
        │   hash: "abc123..."                  │
        │ }                                    │
        └──────────────────────────────────────┘
```

## Key Rotation Flow

```
┌──────────────────────────────────────────────────────────┐
│          State Before Rotation                           │
│                                                          │
│  audit_key_metadata:                                    │
│  ┌──────────────────────────────────┐                  │
│  │ keyId: "key-2024-01"             │                  │
│  │ isActive: 1                      │ ◄─ Active        │
│  │ revokedAt: NULL                  │                  │
│  └──────────────────────────────────┘                  │
│                                                          │
│  New records signed with key-2024-01                    │
│  Old records verified with key-2024-01                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
              │
              │ rotateKey('key-2024-02')
              ▼
┌──────────────────────────────────────────────────────────┐
│          Rotation Steps                                  │
│                                                          │
│ 1. Load new key from secrets (AUDIT_HMAC_KEY_*)        │
│                                                          │
│ 2. UPDATE old key: isActive = 0                        │
│    ┌──────────────────────────────────┐               │
│    │ keyId: "key-2024-01"             │               │
│    │ isActive: 0                      │ ◄─ Inactive   │
│    │ revokedAt: NULL                  │               │
│    └──────────────────────────────────┘               │
│                                                          │
│ 3. INSERT new key: isActive = 1                        │
│    ┌──────────────────────────────────┐               │
│    │ keyId: "key-2024-02"             │               │
│    │ isActive: 1                      │ ◄─ Active    │
│    │ revokedAt: NULL                  │               │
│    └──────────────────────────────────┘               │
│                                                          │
│ 4. Update in-memory activeKeyId                        │
│                                                          │
└──────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────┐
│          State After Rotation                            │
│                                                          │
│  audit_key_metadata:                                    │
│  ┌──────────────────────────────────┐                  │
│  │ keyId: "key-2024-01"             │                  │
│  │ isActive: 0                      │ ◄─ Historic     │
│  │ revokedAt: NULL                  │    (verify only)│
│  └──────────────────────────────────┘                  │
│  ┌──────────────────────────────────┐                  │
│  │ keyId: "key-2024-02"             │                  │
│  │ isActive: 1                      │ ◄─ Active       │
│  │ revokedAt: NULL                  │    (sign new)   │
│  └──────────────────────────────────┘                  │
│                                                          │
│  New records signed with key-2024-02                    │
│  Old records verified with key-2024-01 (retained)       │
│  Chain remains intact                                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

## Tamper Detection

```
┌──────────────────────────────────────────────────────────────────┐
│                     Tamper Scenario 1: Missing Record             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Record 1          Record 2 (DELETED)      Record 3             │
│  ┌────────────┐    ⚠ MISSING ⚠            ┌────────────┐       │
│  │ seq: 1     │                           │ seq: 3     │       │
│  │ prevH: 0   │                           │ prevH: H2  │       │
│  │ payloadH:H1│                           │ payloadH:H3│       │
│  └────────────┘                           └────────────┘       │
│         │                                        ▲               │
│         └────────────────────────────────────────┘               │
│            Missing link (record 2)                              │
│                                                                  │
│  verifyChain() detects: "gap_in_sequence"                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│               Tamper Scenario 2: Hash Mismatch                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Record 1          Record 2 (CORRUPTED)        Record 3         │
│  ┌────────────┐    ┌────────────────┐        ┌────────────┐    │
│  │ payloadH:H1│───►│ prevH: H1 ✓    │        │ prevH: H2' │    │
│  │            │    │ payloadH: H2'  │───────►│            │    │
│  └────────────┘    │ (tampered!)    │        └────────────┘    │
│                    └────────────────┘                           │
│                                                                  │
│  verifyChain(streamId, 3) detects:                              │
│  "hash_mismatch: expected H2, got H2'"                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│          Tamper Scenario 3: Sequence Violation                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Attempt to insert duplicate sequence:                          │
│                                                                  │
│  INSERT INTO audit_stream_records                               │
│    (streamId='c123', sequence=2, ...)                           │
│                                                                  │
│  UNIQUE constraint violation:                                   │
│  "uq_stream_sequence UNIQUE(streamId, sequence)"               │
│                                                                  │
│  Database throws: Error (duplicate key)                         │
│  verifyChain() detects: "sequence violation"                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Checkpoint and Export

```
┌────────────────────────────────────────────────────────────────┐
│                  Checkpoint Creation                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Current Stream Head:                                          │
│  ┌──────────────────────┐                                     │
│  │ streamId: "c123"     │                                     │
│  │ sequence: 42         │                                     │
│  │ payloadHash: "hash42"│                                     │
│  │ keyId: "key-24-01"   │                                     │
│  │ createdAt: T         │                                     │
│  └──────────────────────┘                                     │
│         │                                                      │
│         │ createCheckpoint(streamId)                           │
│         ▼                                                      │
│  ┌──────────────────────────────────────────┐                │
│  │ Checkpoint saved to audit_stream_         │                │
│  │ checkpoints table:                        │                │
│  │                                           │                │
│  │ streamId: "c123"                         │                │
│  │ sequence: 42                             │                │
│  │ headHash: "hash42"                       │                │
│  │ keyId: "key-24-01"                       │                │
│  │ createdAt: now()                         │                │
│  │                                           │                │
│  │ Unique("uq_stream_checkpoint",           │                │
│  │        ["streamId"])                     │                │
│  │ → Only one checkpoint per stream         │                │
│  └──────────────────────────────────────────┘                │
│                                                                │
│  Used for recovery and external verification                  │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│          Export for External Verification                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  exportCheckpointForVerification(streamId):                    │
│                                                                │
│  Returns:                                                      │
│  {                                                             │
│    checkpoint: {                                               │
│      streamId: "c123",                                        │
│      sequence: 42,                                            │
│      headHash: "hash42",                                      │
│      keyId: "key-24-01",                                      │
│      createdAt: "2024-01-24T12:00:00Z"                        │
│    },                                                          │
│    records: [                                                  │
│      { streamId, sequence: 1, previousHash: "0", payloadHash │
│        hmacSignature, keyId, timestamp, createdAt },         │
│      ...                                                       │
│      { streamId, sequence: 42, previousHash: "hash41",       │
│        payloadHash: "hash42", hmacSignature, keyId, ...}    │
│    ]                                                           │
│  }                                                             │
│                                                                │
│  External verifier can:                                        │
│  1. Reconstruct hash chain                                    │
│  2. Download key material (keyId reference)                   │
│  3. Recompute HMAC signatures                                 │
│  4. Verify checkpoint matches stream                          │
│  5. Prove stream was not tampered                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Concurrency Safety

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Concurrent Append Attempts                         │
│                                                                     │
│  Replica 1              Replica 2              Replica 3          │
│  ┌──────────┐          ┌──────────┐          ┌──────────┐         │
│  │ Append   │          │ Append   │          │ Append   │         │
│  │ seq=43   │          │ seq=43   │          │ seq=43   │         │
│  │ prevH=42 │          │ prevH=42 │          │ prevH=42 │         │
│  └────┬─────┘          └────┬─────┘          └────┬─────┘         │
│       │                     │                     │                │
│       └─────────────────────┼─────────────────────┘                │
│                             │                                      │
│                   ┌─────────▼─────────┐                            │
│                   │ Database          │                            │
│                   │                   │                            │
│                   │ Unique constraint:│                            │
│                   │ (streamId, seq)   │                            │
│                   │                   │                            │
│       ┌───────────┤ Transaction 1:    │                            │
│       │           │ INSERT seq=43 ✓   │                            │
│       │           │                   │                            │
│       │           │ Transaction 2:    │                            │
│       │           │ INSERT seq=43     │                            │
│       │           │ UNIQUE violation  │                            │
│       │           │ REJECTED ✗        │                            │
│       │           │                   │                            │
│       │           │ Transaction 3:    │                            │
│       │           │ INSERT seq=43     │                            │
│       │           │ UNIQUE violation  │                            │
│       │           │ REJECTED ✗        │                            │
│       │           └───────────────────┘                            │
│       │                                                             │
│       ▼                                                             │
│  Result:                                                            │
│  • Exactly one succeeds (seq=43 inserted)                          │
│  • Two are rejected (must retry)                                   │
│  • No duplicates, no data loss                                     │
│  • No split-brain across replicas                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Startup Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         NestJS Bootstrap                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ AuditStreamModule (Global)                                   │  │
│  │                                                              │  │
│  │  Startup Check:                                             │  │
│  │  ┌────────────────────────────────────┐                     │  │
│  │  │ if NODE_ENV=production:            │                     │  │
│  │  │   store = DurableAuditStreamStore  │◄─ Durable + Secure│  │
│  │  │ else:                              │                     │  │
│  │  │   store = InMemoryAuditStreamStore │◄─ Test/Dev only   │  │
│  │  └────────────────────────────────────┘                     │  │
│  │                                                              │  │
│  │  ┌─────────────────────────────────────────┐               │  │
│  │  │ SecretAuditKeyRegistry.onModuleInit()   │               │  │
│  │  │                                          │               │  │
│  │  │ 1. Load AUDIT_ACTIVE_KEY_ID             │               │  │
│  │  │    if (!keyId) ➜ throw Error            │               │  │
│  │  │                                          │               │  │
│  │  │ 2. Load AUDIT_HMAC_KEY_<keyId>          │               │  │
│  │  │    if (!material) ➜ throw Error         │               │  │
│  │  │                                          │               │  │
│  │  │ 3. Cache key material in memory         │               │  │
│  │  │    (Never persisted)                     │               │  │
│  │  │                                          │               │  │
│  │  │ ✓ Ready to sign/verify                  │               │  │
│  │  └─────────────────────────────────────────┘               │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────┐                │  │
│  │  │ AuditStreamModule.onModuleInit()       │                │  │
│  │  │                                         │                │  │
│  │  │ if production && store is InMemory:    │                │  │
│  │  │   ➜ throw Error(                       │                │  │
│  │  │       "CRITICAL: Production audit     │                │  │
│  │  │        configured with                │                │  │
│  │  │        InMemoryAuditStreamStore"       │                │  │
│  │  │     )                                  │                │  │
│  │  │                                         │                │  │
│  │  │ ✓ Store initialization verified        │                │  │
│  │  └────────────────────────────────────────┘                │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────┐                │  │
│  │  │ Application Ready                       │                │  │
│  │  │                                         │                │  │
│  │  │ ✓ DurableAuditStreamStore initialized  │                │  │
│  │  │ ✓ Active key loaded                    │                │  │
│  │  │ ✓ SecretAuditKeyRegistry ready         │                │  │
│  │  │ ✓ AuditStreamService injectable        │                │  │
│  │  │                                         │                │  │
│  │  │ Ready to append and verify records     │                │  │
│  │  └────────────────────────────────────────┘                │  │
│  │                                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  If any check fails:                                                │
│  ➜ Application fails to start                                       │
│  ➜ Error is logged (logs, alerting)                                 │
│  ➜ Manual intervention required                                     │
│  ➜ No silent fallback to insecure mode                              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

These diagrams illustrate the core concepts of the audit stream implementation.
For more details, see `AUDIT_STREAM_IMPLEMENTATION.md`.
