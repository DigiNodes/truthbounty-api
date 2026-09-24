# 🛠️ TruthBounty Profiling Operations Manual

## Operator Workflow

This manual outlines standard operating procedures for backend performance monitoring, interpreting flame graphs, investigating latency spikes, and detecting regressions during releases.

---

## 1. Daily Health & Performance Inspection

1. Open the Profiling Dashboard at `http://localhost:3000/profiler/dashboard`.
2. Inspect the **Average Latency**, **p95 Latency**, and **p99 Latency** cards.
3. Check the **Slowest Endpoints** table to identify endpoints exceeding SLA targets (> 200ms).
4. Review the **Database Query Bottlenecks** table for queries taking longer than 100ms.

---

## 2. Investigating Latency Spikes with Flame Graphs

When an endpoint experiences elevated latency:

1. Fetch recent slow traces for the endpoint:
   ```bash
   GET /profiler/traces?route=/claims&minDurationMs=200
   ```
2. Retrieve the trace ID from the response.
3. Fetch the flame graph structure:
   ```bash
   GET /profiler/traces/{traceId}/flamegraph
   ```
4. Examine `value` and `percentage` fields of child nodes to isolate whether time is spent in:
   - Database queries (`category: "db"`)
   - Redis operations (`category: "redis"`)
   - External RPC calls (`category: "blockchain"`)
   - Webhook delivery (`category: "notification"`)

---

## 3. Deployment Baseline & Regression Testing

Before releasing a new backend version:

1. Take a baseline snapshot of the current release:
   ```bash
   POST /profiler/snapshots
   Body: { "name": "release-v1.4.0-baseline" }
   ```
2. Deploy the target release candidate to staging/production.
3. Run performance test load or allow production traffic to collect traces.
4. Take a target snapshot:
   ```bash
   POST /profiler/snapshots
   Body: { "name": "release-v1.5.0-candidate" }
   ```
5. Execute automated regression detection:
   ```bash
   GET /profiler/regressions?baselineId={baselineId}&targetId={targetId}&thresholdPercent=20
   ```
6. If `status` is `"regressions_detected"`, review the `regressions` array for components with >20% latency degradation.

---

## 4. Tuning Production Sampling Strategies

| Strategy | Description | Recommended Environment |
| :--- | :--- | :--- |
| `always-sample` (fixed-rate 1.0) | Captures 100% of request traces | Local Development, Staging |
| `fixed-rate` (0.05 – 0.20) | Captures fixed percentage of requests | Production (low-to-medium traffic) |
| `adaptive` | Dynamically throttles sampling if CPU exceeds 80% | Production (high traffic / auto-scaling) |
| `header-based` | Samples on-demand via HTTP header `x-profile-request: true` | Production Debugging |


---

## 5. Evidence Integrity Monitoring & Operations (V2-BE-013)

The Evidence Metadata Integrity Protection system provides cryptographic verification of evidence projection correctness. Operators must monitor integrity health and respond to failures.

### Daily Integrity Health Check

1. Check evidence integrity health status:
   ```bash
   GET /v2/evidence/integrity/health
   ```

2. Verify stamping coverage is >99% (healthy threshold):
   - `healthy`: No action required
   - `degraded` (95-99%): Schedule backfill during next maintenance window
   - `critical` (<95%): **Immediate action required** - run backfill immediately

3. Review integrity statistics:
   ```bash
   GET /v2/evidence/integrity/statistics
   ```

### Weekly Integrity Verification

Run sample verification on random evidence subset:

```bash
# Sample 100 random evidence items
psql truthbounty -t -c "SELECT evidence_id FROM v2_project_evidence ORDER BY RANDOM() LIMIT 100" \
  | jq -R -s -c 'split("\n") | map(select(length > 0))' \
  | curl -X POST http://localhost:3000/v2/evidence/integrity/verify-batch \
      -H "Content-Type: application/json" \
      -d @- \
  > integrity_sample_$(date +%Y%m%d).json

# Review results
cat integrity_sample_$(date +%Y%m%d).json | jq '.summary'
```

### Alert Response Procedures

| Alert | Severity | Action |
| :--- | :--- | :--- |
| `EvidenceIntegrityFailure` | Critical | Follow **Scenario 1** in Evidence Integrity Runbook |
| `EvidenceIntegrityUnstampedRecords` | Warning | Schedule backfill during maintenance window |
| `ProjectorHaltedIntegrityError` | Critical | Follow **Scenario 3** in Evidence Integrity Runbook |

### Common Operations

**Verify Single Evidence:**
```bash
curl http://localhost:3000/v2/claims/{CLAIM_ID}/evidence/integrity
```

**Batch Verify Multiple Evidence:**
```bash
curl -X POST http://localhost:3000/v2/evidence/integrity/verify-batch \
  -H "Content-Type: application/json" \
  -d '{"evidenceIds": ["0x123...", "0x456...", "0x789..."]}'
```

**Run Integrity Backfill:**
```bash
# Stop projector first
systemctl stop truthbounty-projector

# Run backfill
npm run evidence:backfill -- --batch-size 100

# Restart projector
systemctl start truthbounty-projector
```

### Detailed Runbook

For detailed procedures, troubleshooting, and recovery steps, refer to:

📖 **[Evidence Integrity Runbook](./EVIDENCE_INTEGRITY_RUNBOOK.md)**

Covers:
- Single evidence integrity failure recovery
- Mass integrity failure handling
- Projector halt due to hash computation errors
- Chain reorg verification
- Migration procedures (Phase 1, 2, 3)
- Monitoring metrics and alert rules
- Troubleshooting guide

---

## Related Documentation

- **[Performance Guide](./PERFORMANCE_GUIDE.md)** - Query optimization and caching
- **[Monitoring Guide](./MONITORING_GUIDE.md)** - Metrics, alerts, and dashboards
- **[Disaster Recovery](./DISASTER_RECOVERY.md)** - Backup and restoration procedures
- **[Evidence Integrity Runbook](./EVIDENCE_INTEGRITY_RUNBOOK.md)** - Evidence integrity operations
- **[Indexer Runbook](./indexer-runbook.md)** - Blockchain event indexing operations
