# Sanitized Public Incident Projection (UX-BE-002)

`GET /status/incidents` and `GET /status/incidents/:incidentId` provide a dedicated, sanitized, versioned (`public-incidents.v1`) projection for public incident and status screens.

This interface satisfies **UX-BE-002 (#592)** and the **Batch 6 authority** ([`SUPPORT_LEGAL_SCREEN_AUTHORITY.md`](https://github.com/DigiNodes/truthbounty-protocol/blob/main/docs/ux-authority/SUPPORT_LEGAL_SCREEN_AUTHORITY.md)).

Protected administrator incident records in `/admin/incidents/*` are kept strictly separate from this public projection.

## Published artifacts

| File | Purpose |
| --- | --- |
| [`openapi.json`](./openapi.json) | OpenAPI 3 document for `GET /status/incidents` and `GET /status/incidents/:incidentId` |
| [`fixtures.json`](./fixtures.json) | Frontend fixtures covering monitoring, resolved, stale, unavailable, pagination, unknown ID, publication history, and sanitized untrusted inputs |

Both are verified against the active codebase by:
`src/health/public-incidents/public-incidents.artifacts.spec.ts`.

Regenerate after a schema change with:
```bash
UPDATE_PUBLIC_INCIDENTS_ARTIFACTS=1 npx jest public-incidents.artifacts
```

---

## Schema & Separation Guarantees

### 1. Structural Separation
The public projection DTOs (`PublicIncidentListResponseDto`, `PublicIncidentDetailDto`, `PublicIncidentSummaryDto`, `PublicIncidentHistoryRecordDto`) are structurally independent from the administrator `Incident` entity:
- No shared base classes and no object spreads (`{ ...incident }`).
- Protected fields are never published: `investigationNotes`, `reportedBy`, `assignedTo`, `relatedEntityType`, `relatedEntityId`, internal resolution author, internal post-incident report authors, and unreviewed drafts.
- Unapproved drafts (`isDraft: true` or `isApproved: false`) are completely excluded from the public projection.

### 2. Immutable Timestamps & Audit History
Every publication record carries immutable ISO 8601 timestamps:
- `startedAt`: When the incident occurred or was observed.
- `updatedAt`: When the latest public update was published.
- `resolvedAt`: When the incident reached `resolved` status (null while ongoing).
- `publicationHistory`: Append-only chronological list of updates (`investigating` → `identified` → `monitoring` → `resolved`). Past timestamps and messages are immutable.
- `publicationSequence`: Monotonically increasing counter for revision tracking and auditing.

### 3. Affected Components & Impact
- `affectedComponents`: Subsets of the canonical public components from UX-BE-001 (`web`, `api`, `rpc`, `indexer`, `database`, `evidence_gateway`).
- `impact`: Assessed user-facing impact (`none`, `minor`, `major`, `critical`).
- `status`: Incident lifecycle state (`investigating`, `identified`, `monitoring`, `resolved`).

---

## Scenarios Covered

1. **Monitoring**:
   Active incident in `monitoring` status (e.g. latency mitigation applied, stability observation in progress).
2. **Resolved**:
   Completed incident with `resolvedAt`, mitigation narrative, and approved post-incident links.
3. **Stale**:
   If an observation or update is older than `staleAfterSeconds` (default: 120s), the projection is labelled `freshness: 'stale'`.
4. **Unavailable**:
   If the backing store is unconfigured or encounters an error, the API fails closed without leaking database hostnames or internal credentials.
5. **Pagination**:
   List endpoint supports `page` and `limit` query parameters with total item counts, total pages, `hasNext`, and `hasPrevious`.
6. **Unknown ID**:
   Querying a non-existent, unapproved, or draft incident ID safely returns `404 Not Found` without disclosing system details.
7. **Publication History**:
   Audit trail detailing past updates and status transitions over time.
8. **Sanitized Untrusted Markdown & URLs**:
   All untrusted HTML tags (`<script>`, `<iframe`, etc.) are stripped, dangerous link schemes (`javascript:`, `data:`, `file:`) are neutralized, and URLs must be valid `https:` links to public destinations (blocking private IP ranges, cloud metadata, and localhost).

---

## Fail-Closed Rules

- Unapproved records or drafts → completely omitted from list; 404 for direct lookup.
- Backing store failure → HTTP 503 Service Unavailable with sanitized message; never leaks stack traces or SQL strings.
- Stale updates → freshness reported as `stale`, never claimed as fresh.
- Untrusted URLs → filtered out; links to private IP addresses or internal hostnames are discarded.

---

## Configuration

| Environment Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_INCIDENTS_CACHE_TTL_SECONDS` | `15` | Projection cache TTL and Cache-Control max-age |
| `PUBLIC_INCIDENTS_STALE_AFTER_SECONDS` | `120` | Threshold beyond which an observation is marked stale |
| `PUBLIC_INCIDENTS_RATE_LIMIT` | `60` | Requests allowed per IP per window |
| `PUBLIC_INCIDENTS_RATE_WINDOW_SECONDS` | `60` | Duration of rate-limiting window |
