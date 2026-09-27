# Idempotency Keys for Safe Commands - Usage Guide

## Overview

Idempotency keys ensure that duplicate requests for the same operation produce the same result, preventing duplicate actions and improving reliability. This is particularly important for critical operations like creating claims, submitting evidence, and filing disputes.

## When to Use Idempotency Keys

Idempotency keys should be used for all write operations that have side effects, including:

- Creating claims (`POST /claims`)
- Adding evidence to claims (`POST /claims/:claimId/evidence`)
- Creating disputes (`POST /disputes`)

## How to Use Idempotency Keys

### Client-Side Implementation

When making a request that requires idempotency, include a unique `Idempotency-Key` header in your request:

```http
POST /claims HTTP/1.1
Content-Type: application/json
Idempotency-Key: 5b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c
Authorization: Bearer <your-jwt-token>

{
  "title": "Example Claim",
  "content": "This is the content of the claim"
}
```

The `Idempotency-Key` should be a unique identifier that represents the specific operation being performed. We recommend using a cryptographically secure random string with at least 32 characters.

### Handling Duplicate Requests

If you receive a `200 OK` response with a claim ID, and then make the same request again with the same `Idempotency-Key`, you will receive the same response without creating a duplicate claim. This is useful for handling network issues or client retries.

### Client-Side Example (JavaScript)

```javascript
async function createClaimWithIdempotency(claimData) {
  // Generate a unique idempotency key
  const idempotencyKey = generateIdempotencyKey();

  try {
    const response = await fetch('/claims', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Authorization': `Bearer ${getAuthToken()}`
      },
      body: JSON.stringify(claimData)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    // If it's a network error or 5xx server error, retry with the same idempotency key
    if (shouldRetry(error)) {
      return createClaimWithIdempotency(claimData);
    }
    throw error;
  }
}

function generateIdempotencyKey() {
  // Generate a random 32-character hex string
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

## Server-Side Implementation

The server handles idempotency by:

1. Checking for the `Idempotency-Key` header in incoming requests
2. Looking up the key in Redis to see if we've already processed this request
3. If found, returning the stored response
4. If not found, processing the request and storing the response with the key

### Configuration

Idempotency behavior can be configured through environment variables:

- `IDEMPOTENCY_ENABLED`: Whether idempotency is enabled (default: true)
- `IDEMPOTENCY_TTL`: Time-to-live for stored responses in seconds (default: 86400/24 hours)
- `IDEMPOTENCY_KEY_LENGTH`: Required length of idempotency keys in characters (default: 32)

## Error Handling

### Missing Idempotency Key

If an endpoint requires an idempotency key but none is provided, the server will return a `400 Bad Request` response:

```json
{
  "error": "Idempotency key is required for this operation",
  "message": "Please include an Idempotency-Key header with your request"
}
```

### Invalid Idempotency Key

If the provided idempotency key is invalid (e.g., wrong length or format), the server will return a `400 Bad Request` response:

```json
{
  "error": "Invalid idempotency key",
  "message": "The idempotency key must be a hexadecimal string of at least 32 characters"
}
```

### Redis Unavailable

If Redis is unavailable, idempotency functionality will be disabled, and the server will process requests normally. This ensures the service remains available even if idempotency fails.

## Best Practices

1. **Generate unique keys**: Use a cryptographically secure random generator to create idempotency keys.
2. **Don't reuse keys**: Each request should have a unique idempotency key.
3. **Store keys securely**: Ensure idempotency keys are not logged or exposed in error messages.
4. **Handle timeouts**: Implement client-side timeouts and retry logic for network issues.
5. **Test thoroughly**: Test both normal operation and failure scenarios (network issues, duplicates, etc.).

## Security Considerations

- Idempotency keys should be treated as sensitive data and not exposed in logs or error messages
- Keys should be sufficiently random and long to prevent guessing
- The server should reject requests with malformed or invalid keys
- Consider rate limiting in conjunction with idempotency to prevent abuse
