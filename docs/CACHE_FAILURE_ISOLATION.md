# Cache Failure Isolation (V2-BE-116)

## Overview

This document describes the implementation of cache failure isolation for the TruthBounty API. Per V2-BE-116, cache failures are now isolated from canonical state (TypeORM/PostgreSQL) to ensure that the API never silently falls back to fabricated state when Redis is unavailable or fails.

## Problem Statement

Prior to this implementation, the caching layer had graceful degradation that silently fell back to database queries when Redis failed. While this maintained availability, it masked cache failures and violated the fail-closed principle required for protocol correctness. The API must never invent, mutate, or override protocol truth, and cache failures must be observable.

## Design Principles

1. **Fail-Closed Behavior**: Cache failures are explicitly thrown as `CacheUnavailableException` rather than silently returning null/false
2. **Observable Failures**: All cache failures are logged and recorded in metrics for monitoring and alerting
3. **Canonical State Authority**: TypeORM/PostgreSQL remains the single source of truth; cache is purely a performance optimization
4. **No Silent Fallback**: Services explicitly catch cache exceptions and serve from database with observable logging
5. **Protocol Correctness**: Smart contracts and finalized canonical events remain authoritative for protocol state

## Implementation Components

### 1. CacheUnavailableException

**Location**: `src/cache/exceptions/cache-unavailable.exception.ts`

A custom exception type that isolates cache failures from other system errors. It includes:
- Operation type (GET, SET, DELETE, CONNECTION)
- Cache key (when applicable)
- Original error context
- Static factory methods for common scenarios

```typescript
// Example usage
throw CacheUnavailableException.forGet('v1:claim:123', error);
throw CacheUnavailableException.forSet('v1:claim:123', error);
throw CacheUnavailableException.forConnection(error);
```

### 2. CacheHealthService

**Location**: `src/cache/cache-health.service.ts`

Tracks cache health metrics and failure rates:
- Records success/failure counts for cache operations
- Calculates failure rate
- Tracks last failure time
- Marks cache as unhealthy when failure threshold exceeded (default: 10 failures)
- Reports metrics to Prometheus/Grafana for monitoring

**Metrics Exported**:
- `cache_operations_total` (labels: operation, status)
- `cache_failures_total` (labels: operation)
- `cache_failure_rate` (gauge)
- `cache_failure_count` (gauge)
- `cache_success_count` (gauge)
- `cache_healthy` (gauge: 0 or 1)

### 3. Updated Cache Services

**ClaimsCache** (`src/cache/claims.cache.ts`):
- All cache operations now throw `CacheUnavailableException` on Redis failures
- Integrates with `CacheHealthService` to record success/failure metrics
- JSON parse errors are recorded as failures but return null (cache miss behavior)

**Example**:
```typescript
async getClaim(id: string): Promise<any | null> {
    const key = this.getClaimKey(id);
    try {
        const data = await this.redisService.get(key);
        if (data) {
            this.cacheHealthService.recordSuccess('GET');
            return JSON.parse(data);
        }
        this.cacheHealthService.recordSuccess('GET');
        return null; // Cache miss
    } catch (error) {
        this.cacheHealthService.recordFailure('GET', key, error as Error);
        throw CacheUnavailableException.forGet(key, error as Error);
    }
}
```

### 4. Service Layer Updates

**ClaimsService** (`src/claims/claims.service.ts`):
- Catches `CacheUnavailableException` explicitly
- Logs cache failures observably with warn-level logs
- Falls back to canonical database state
- Continues operation without propagating cache errors to clients

**Example**:
```typescript
async findOne(id: string): Promise<Claim | null> {
    try {
        const cached = await this.claimsCache.getClaim(id);
        if (cached) return cached;
    } catch (error) {
        if (error instanceof CacheUnavailableException) {
            this.logger.warn(`Cache unavailable for claim ${id}, serving from database: ${error.message}`);
            // Fall through to database fetch
        } else {
            throw error;
        }
    }

    const claim = await this.claimRepo.findOneBy({ id });
    if (claim) {
        try {
            await this.claimsCache.setClaim(id, claim);
        } catch (error) {
            if (error instanceof CacheUnavailableException) {
                this.logger.warn(`Cache unavailable for claim ${id}, skipping cache update: ${error.message}`);
                // Continue - cache failure is isolated
            } else {
                throw error;
            }
        }
    }
    return claim;
}
```

### 5. Metrics Service Enhancements

**MetricsService** (`src/metrics/metrics.service.ts`):
- Added support for labeled counters and gauges
- Enables cache health metrics with operation and status labels

## Operational Considerations

### Monitoring and Alerting

**Key Metrics to Monitor**:
1. `cache_failure_rate` - Alert if > 0.1 (10% failure rate)
2. `cache_healthy` - Alert if drops to 0
3. `cache_failures_total` - Alert on sudden spikes
4. `cache_operations_total` - Monitor overall cache activity

**Recommended Grafana Queries**:
```promql
# Cache failure rate
rate(cache_failures_total[5m]) / rate(cache_operations_total[5m])

# Cache health status
cache_healthy

# Cache failures by operation
sum by (operation) (rate(cache_failures_total[5m]))
```

### Health Check Impact

The existing health check in `HealthService` already marks Redis as non-critical (`critical: false`). This means:
- API remains available when Redis is down
- Cache failures are reported as "degraded" status
- Critical dependencies (database, blockchain, queue) still enforce fail-closed behavior

### Recovery Procedures

**When Redis is Unavailable**:
1. API continues serving from canonical database
2. Cache failures are logged and metrics are recorded
3. No user-facing impact (slightly higher latency)
4. Monitor `cache_healthy` metric for recovery

**When Redis Recovers**:
1. Cache operations automatically resume
2. `cache_healthy` metric returns to 1
3. Cache gradually repopulates from database queries
4. No manual intervention required

**Persistent Cache Issues**:
1. Check Redis connectivity and configuration
2. Review Redis logs for errors
3. Verify network connectivity to Redis
4. Check Redis memory usage and eviction policies
5. Consider scaling Redis if capacity issues

## Testing

### Unit Tests

**Location**: `src/cache/exceptions/cache-unavailable.exception.spec.ts`
- Tests exception factory methods
- Validates exception properties
- Covers all operation types

**Location**: `src/cache/cache-health.service.spec.ts`
- Tests success/failure recording
- Validates health status calculation
- Tests failure threshold logic
- Validates Redis connection status

**Location**: `src/cache/claims.cache.spec.ts`
- Tests cache operations throw exceptions on failure
- Validates health service integration
- Tests JSON parse error handling
- Validates success/failure metric recording

### Integration Tests

**Location**: `test/cache-failure-isolation.e2e-spec.ts`
- Tests cache failure isolation from canonical state
- Validates database fallback behavior
- Tests observable logging of failures
- Validates no silent fallback to fabricated state
- Tests recovery after cache restoration

## Security and Architecture Compliance

This implementation adheres to V2-BE-116 requirements:

✅ **Optimism/EVM Only**: No alternative-chain runtime paths added
✅ **Smart Contract Authority**: Canonical chain events remain authoritative
✅ **No Backend Mutation**: No backend-authoritative settlement, rewards, or governance
✅ **TypeORM-Only Persistence**: No Prisma or second ORM introduced
✅ **Fail-Closed Behavior**: Cache failures are observable, not silent
✅ **No Secrets Committed**: No credentials or production values in code

## Migration Guide

### For Service Developers

When adding new cache operations:

1. **Throw `CacheUnavailableException`** on Redis failures:
```typescript
try {
    await this.redisService.set(key, value, ttl);
    this.cacheHealthService.recordSuccess('SET');
} catch (error) {
    this.cacheHealthService.recordFailure('SET', key, error as Error);
    throw CacheUnavailableException.forSet(key, error as Error);
}
```

2. **Catch exceptions in service layer**:
```typescript
try {
    const cached = await this.cache.get(key);
    if (cached) return cached;
} catch (error) {
    if (error instanceof CacheUnavailableException) {
        this.logger.warn(`Cache unavailable, serving from database: ${error.message}`);
        // Fall through to database
    } else {
        throw error;
    }
}
```

3. **Record metrics** for all cache operations:
```typescript
this.cacheHealthService.recordSuccess('GET');
this.cacheHealthService.recordFailure('GET', key, error);
```

### For Operators

1. **Update monitoring dashboards** to include cache health metrics
2. **Configure alerts** for cache failure rate and health status
3. **Review logs** for cache failure warnings during Redis outages
4. **Monitor Redis capacity** to prevent eviction-related failures

## Future Enhancements

Potential improvements for future iterations:

1. **Circuit Breaker Pattern**: Add circuit breaker to temporarily disable cache after repeated failures
2. **Cache Warming**: Implement proactive cache warming after Redis recovery
3. **Distributed Tracing**: Add trace IDs to cache operations for debugging
4. **Cache Partitioning**: Isolate cache failures by domain (claims, governance, reputation)
5. **Redis Sentinel/Cluster**: Improve Redis high availability and failover

## References

- V2-BE-116 Issue: https://github.com/DigiNodes/truthbounty-api/issues/470
- ARCHITECTURE.md: System architecture and data flow
- SECURITY.md: Security requirements and protocols
