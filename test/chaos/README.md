# PREWAVE-BE-091 & PREWAVE-BE-092 — Deterministic Dependency Chaos & Optimism Sepolia Soak

This scaffold provides standardized, deterministic fault injection and soak evidence generation for the TruthBounty backend without introducing architectural drift or assuming maintainer authority.

## Standardized Dependency Adapters (PREWAVE-BE-091)

The following 8 dependency adapters are implemented with safe environment guards:

1. `DatabaseFaultAdapter`: Fail, slow (latency injection), corrupt (transaction serialization failure), and recovery for PostgreSQL/TypeORM/Prisma.
2. `RedisFaultAdapter`: Fail, slow, corrupt (WRONGTYPE / invalid payload), and recovery for Redis cache/locks.
3. `RpcFaultAdapter`: Fail, slow, corrupt (stale head divergence / unfinalized state), and recovery for Optimism Sepolia RPC.
4. `IpfsFaultAdapter`: Fail, slow, corrupt (tampered evidence buffer failing CID verification), and recovery for IPFS storage.
5. `ProviderFaultAdapter`: Fail, slow, corrupt (malformed schema completion), and recovery for external AI/oracle providers.
6. `QueueFaultAdapter`: Fail, slow, corrupt (duplicate delivery / poison message), and recovery for BullMQ / transactional outbox.
7. `StreamFaultAdapter`: Fail, slow, corrupt (malformed framing / out-of-order frames), and recovery for WebSocket/SSE event streams.
8. `ClockFaultAdapter`: Skew (time drift), freeze, leap forward/backward, and recovery for system clock.

## Safe Environment Guards

- **Strict Production Target Rejection:** All adapters and orchestrators validate target URLs against production hostname patterns (`mainnet`, `prod`, `truthbounty.io`, etc.).
- **Environment Isolation:** Throws `ProductionTargetError` if `NODE_ENV === 'production'`, `APP_ENV === 'production'`, or `STAGE === 'prod'`.
- **Explicit Authorization:** Requires `TRUTHBOUNTY_CHAOS_ALLOWED=true` to permit simulated fault injection.
- **Credential Redaction:** Automatically sanitizes passwords, bearer tokens, private keys (`0x[a-f0-9]{64}`), and secrets from error logs and evidence output.

## Recovery Invariants

- **No-Gap Invariant (`assertNoGap`):** Proves contiguous block heights and sequential outbox event deliveries with zero omissions.
- **No-Duplicate Invariant (`assertNoDuplicate`):** Proves exactly zero repeated side effects or duplicate projection entries.
- **No-False-Freshness (`assertNoFalseFreshness`):** Proves lagging or stale state degrades explicitly rather than serving stale projections as authoritative head.
- **Digest Parity (`assertDigestParity`):** Validates byte-for-byte SHA-256 state projection equality between replayed local state and canonical contract state.

## Optimism Sepolia Soak Runner (PREWAVE-BE-092)

Runs the sustained workload against the pinned Optimism Sepolia release (`chainId: 11155420`, `releaseId: rel-opsepolia-20261015-v2`, deployment block `24850000`):

```bash
# Run the soak evidence generator
npx ts-node scripts/optimism-sepolia-soak-runner.ts

# Execute the automated soak test suite
npm test -- test/load/optimism-sepolia-soak.spec.ts

# Execute the deterministic chaos unit tests
npm test -- test/chaos/unit
```

Evidence artifacts are written to `docs/evidence/`:
- `docs/evidence/OPTIMISM_SEPOLIA_SOAK_EVIDENCE.md`
- `docs/evidence/soak-evidence-opsepolia.json`

