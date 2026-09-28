# V2-BE-087 — Indexer and Dependency Chaos Tests

This scaffold is intentionally adapter-based. It does not assume ownership of the
production indexer, persistence implementation, queue, or RPC client.

## Required adapters

Implement repository-specific adapters before enabling integration scenarios:

- `DatabaseFaultAdapter`: restart/unavailable/restore PostgreSQL.
- `CacheQueueFaultAdapter`: restart Redis and duplicate queue deliveries.
- `RpcFaultAdapter`: timeout, divergence, stale head, and reorg fixtures.
- `ProcessFaultAdapter`: terminate and restart the worker under test.
- `DiskPressureAdapter`: deterministic quota or filesystem-pressure simulation.

## Safety rules

- Use test-only endpoints, fixtures, credentials, and containers.
- Never use production RPC URLs, credentials, personal data, or real wallets.
- Never assert that the API authoritatively settles rewards, treasury, governance,
  or protocol verdicts.
- Assertions must verify bounded failure, redaction, durable recovery, and idempotency.
- Integration tests must be opt-in and must fail clearly when dependencies are absent.

## Suggested execution gates

```bash
npm run lint
npm run build
npm test -- --runInBand test/chaos/unit
npm run test:e2e
npm audit --audit-level=high
```

Add repository-specific Prisma migration and artifact checks after confirming the
current CI workflow and migration policy.
