# Metrics Endpoint Security Implementation

## Overview
The `/metrics` endpoint (Prometheus metrics) has been secured with bearer token authentication to prevent unauthorized access to operational data.

## Changes Made

### 1. Created Metrics Authentication Guard
**File:** `src/metrics/metrics-auth.guard.ts`

This guard implements bearer token authentication for the metrics endpoint:
- Reads the `METRICS_TOKEN` environment variable
- If the token is not set, access is allowed (backward compatibility for development)
- If the token is set, requires a valid `Authorization: Bearer <token>` header
- Returns 401 Unauthorized for invalid or missing tokens

### 2. Created Metrics Module
**File:** `src/metrics/metrics.module.ts`

Properly encapsulates the metrics functionality as a NestJS module.

### 3. Updated Metrics Controller
**File:** `src/metrics/metrics.controller.ts`

Applied the `@UseGuards(MetricsAuthGuard)` decorator to protect the endpoint.

### 4. Updated App Module
**File:** `src/app.module.ts`

Imported `MetricsModule` to register the metrics controller and service.

### 5. Updated Environment Configuration
**File:** `.env.example`

Added documentation for the `METRICS_TOKEN` environment variable with usage instructions.

## Configuration

### Environment Variable

Add this to your `.env` file:

```bash
# Generate a secure token: openssl rand -hex 32
METRICS_TOKEN=your_secure_token_here
```

### Generating a Secure Token

```bash
# Using OpenSSL
openssl rand -hex 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Usage

### With Token (Production)

```bash
# Access metrics with authentication
curl -H "Authorization: Bearer your_secure_token_here" http://localhost:3000/metrics
```

### Without Token (Development Only)

If `METRICS_TOKEN` is not set in the environment, the endpoint allows public access for backward compatibility during development.

**⚠️ Warning:** Always set `METRICS_TOKEN` in production environments.

## Prometheus Configuration

Update your Prometheus configuration to include the bearer token:

```yaml
scrape_configs:
  - job_name: 'truthbounty-api'
    metrics_path: '/metrics'
    bearer_token: 'your_secure_token_here'
    static_configs:
      - targets: ['localhost:3000']
```

## Security Benefits

1. **Prevents Information Leakage**: Operational metrics are no longer publicly accessible
2. **Reconnaissance Protection**: Attackers cannot gather system performance data
3. **Authorized Access Only**: Only authorized Prometheus scrapers can access metrics
4. **Backward Compatible**: Development environments can still access metrics without token

## Testing

### Test with valid token:
```bash
curl -H "Authorization: Bearer your_token" http://localhost:3000/metrics
# Should return metrics data
```

### Test without token (when METRICS_TOKEN is set):
```bash
curl http://localhost:3000/metrics
# Should return: {"statusCode": 401, "message": "Missing authorization header"}
```

### Test with invalid token:
```bash
curl -H "Authorization: Bearer wrong_token" http://localhost:3000/metrics
# Should return: {"statusCode": 401, "message": "Invalid metrics token"}
```

## Alternative: IP-Based Restriction

For deployment environments that support it, you can also restrict access by IP address at the network level (e.g., using nginx, AWS Security Groups, or Kubernetes Network Policies) in addition to token-based authentication.

### Example: Nginx Configuration

```nginx
location /metrics {
    allow 10.0.0.0/8;  # Internal network only
    deny all;
    
    proxy_pass http://localhost:3000/metrics;
}
```

## Production Checklist

- [ ] Generate a strong `METRICS_TOKEN` (at least 32 bytes)
- [ ] Add `METRICS_TOKEN` to production environment variables
- [ ] Update Prometheus scrape configuration with bearer token
- [ ] Test metrics access with token
- [ ] Verify public access is denied without token
- [ ] (Optional) Add IP-based restrictions at network level
- [ ] Monitor unauthorized access attempts via audit logs
