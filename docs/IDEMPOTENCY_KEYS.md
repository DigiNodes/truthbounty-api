# Idempotency Keys for Safe Commands

## Overview

This document outlines the implementation of idempotency keys for safe commands in the TruthBounty API. Idempotency keys ensure that duplicate requests for the same operation produce the same result, preventing duplicate actions and improving reliability.

## Problem Statement

In a distributed system, network issues, client retries, or duplicate submissions can cause the same operation to be executed multiple times. For critical operations like creating claims or submitting evidence, this can lead to inconsistent state. Idempotency keys provide a mechanism to safely handle such scenarios.

## Design Goals

1. **Prevent Duplicate Operations**: Ensure that duplicate requests for the same operation don't create multiple entries.
2. **Maintain Consistency**: Keep the system state consistent even with duplicate requests.
3. **Fail Closed**: Reject requests that can't be safely processed.
4. **Minimal Performance Impact**: Add minimal overhead to the system.
5. **Observable Reporting**: Provide clear logging and metrics for idempotency handling.

## Technical Implementation

### Idempotency Key Generation

Clients generate a unique idempotency key for each request. This key should be a unique identifier that represents the specific operation being performed.

### Key Storage

Idempotency keys will be stored in Redis with a TTL (time-to-live) to automatically clean up old keys. The TTL should be long enough to cover potential retries but short enough to prevent indefinite storage.

### Key Structure

Redis key format: `idempotency:{method}:{path}:{key}`

Value format: JSON object containing:
- `response`: The response body
- `status`: HTTP status code
- `timestamp`: When the response was stored
- `expires`: When the key expires

### Request Flow

1. Client includes an `Idempotency-Key` header in the request
2. Server checks if the key exists in Redis
3. If key exists:
   - Return stored response with 200 status
   - Log as duplicate request
4. If key doesn't exist:
   - Process the request normally
   - Store the response in Redis with the key
   - Return the response

### Implementation Details

#### Middleware

We'll create an IdempotencyMiddleware that:
1. Checks for the `Idempotency-Key` header
2. Validates the key format
3. Checks Redis for existing responses
4. Stores new responses

#### Decorator

We'll create an `@Idempotent()` decorator that can be applied to specific endpoints or controllers.

#### Configuration

Configuration options:
- `idempotencyTTL`: Time-to-live for stored responses (default: 24 hours)
- `idempotencyEnabled`: Whether idempotency is enabled (default: true)
- `idempotencyKeyLength`: Required length of idempotency keys (default: 32)

#### Supported Endpoints

Initially, we'll implement idempotency for:
- POST /claims (create claim)
- POST /claims/:claimId/evidence (add evidence)
- POST /disputes (create dispute)

### Error Handling

1. **Missing Key**: Return 400 Bad Request if a required endpoint is missing the key
2. **Invalid Key**: Return 400 Bad Request if the key is malformed
3. **Expired Key**: Treat as a new request (clean up the expired key)
4. **Storage Error**: Return 503 Service Unavailable if Redis is unavailable

### Security Considerations

1. **Key Uniqueness**: Ensure keys are sufficiently random and long
2. **Sensitive Data**: Don't store sensitive data in stored responses
3. **Access Control**: Ensure clients can only access their own stored responses
4. **Rate Limiting**: Combine with existing rate limiting to prevent abuse

## Testing Strategy

1. **Unit Tests**:
   - Test key generation
   - Test response storage and retrieval
   - Test error conditions

2. **Integration Tests**:
   - Test duplicate request handling
   - Test Redis failure scenarios
   - Test TTL expiration

3. **E2E Tests**:
   - Test client-side idempotency key generation
   - Test retry scenarios
   - Test concurrent requests

## Monitoring and Observability

1. **Metrics**:
   - Number of idempotency hits
   - Number of idempotency misses
   - Number of errors

2. **Logging**:
   - Log duplicate requests with correlation IDs
   - Log errors with stack traces
   - Log Redis connectivity issues

3. **Alerts**:
   - Alert on high error rates
   - Alert on Redis connectivity issues

## Migration Plan

1. Add idempotency middleware and Redis configuration
2. Implement idempotency for critical endpoints
3. Add tests and monitoring
4. Update documentation
5. Deploy to staging with feature flags
6. Deploy to production with feature flags
7. Gradually enable idempotency for all safe operations

## Future Enhancements

1. Support for idempotency keys in WebSocket connections
2. Support for custom TTL per endpoint
3. Support for idempotency key rotation
4. Support for distributed idempotency across multiple services
