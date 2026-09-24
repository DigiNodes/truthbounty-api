# Authentication System

## Overview

The TruthBounty API implements wallet-signature based JWT authentication to secure all mutating endpoints (POST, PATCH, PUT, DELETE). Read-only endpoints (GET) remain public by default.

## Architecture

### Authentication Flow

1. **Request Challenge**: Client requests a nonce challenge for their wallet address
2. **Sign Message**: Client signs the challenge message with their wallet (MetaMask, WalletConnect, etc.)
3. **Login**: Client submits the signature to receive a JWT token
4. **Access Protected Endpoints**: Client includes JWT in Authorization header for subsequent requests

### Components

- **AuthService**: Handles nonce generation, signature verification, and JWT issuance
- **AuthController**: Exposes `/auth/challenge`, `/auth/login`, and `/auth/profile` endpoints
- **GlobalAuthGuard**: Automatically protects all mutation endpoints
- **JwtStrategy**: Passport strategy for JWT validation
- **Public Decorator**: Marks endpoints as publicly accessible

## Usage

### 1. Get Challenge

```bash
POST /auth/challenge
Content-Type: application/json

{
  "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
}

Response:
{
  "message": "Sign in to TruthBounty: aB3dEf7hIj2kLm4nOp6qRs8tUv0wXy",
  "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
}
```

### 2. Sign Message (Client-side)

Using ethers.js:

```javascript
import { ethers } from 'ethers';

// Connect to wallet (e.g., MetaMask)
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

// Sign the challenge message
const message = "Sign in to TruthBounty: aB3dEf7hIj2kLm4nOp6qRs8tUv0wXy";
const signature = await signer.signMessage(message);
```

### 3. Login

```bash
POST /auth/login
Content-Type: application/json

{
  "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  "signature": "0x...",
  "message": "Sign in to TruthBounty: aB3dEf7hIj2kLm4nOp6qRs8tUv0wXy"
}

Response:
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "user-123",
    "address": "0x742d35cc6634c0532925a3b844bc9e7595f0beb"
  }
}
```

### 4. Access Protected Endpoints

```bash
POST /claims
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "title": "Claim title",
  "description": "Claim description"
}
```

## Security Features

### Nonce-Based Challenge
- Each challenge contains a cryptographically secure random nonce
- Nonces expire after 5 minutes
- Nonces are single-use (prevents replay attacks)
- Expired nonces are automatically cleaned up

### Signature Verification
- Uses `ethers.verifyMessage()` to verify ECDSA signatures (EIP-191)
- Validates that the recovered address matches the claimed address
- Prevents signature tampering

### JWT Token
- Signed with HMAC-SHA256 algorithm
- Configurable expiration (default: 7 days)
- Contains wallet address and user ID

### Global Protection
- All POST, PATCH, PUT, DELETE endpoints require authentication
- GET endpoints remain public by default
- Can be overridden with `@Public()` decorator

## Configuration

Add to `.env`:

```env
# JWT Secret (CHANGE THIS IN PRODUCTION!)
JWT_SECRET=your-super-secret-jwt-key-change-in-production

# JWT token expiration time
JWT_EXPIRATION=7d
```

## API Endpoints

### Public Endpoints (No Auth Required)
- `POST /auth/challenge` - Get challenge message
- `POST /auth/login` - Login with signature
- `GET /*` - All GET endpoints (by default)

### Protected Endpoints (Auth Required)
- `POST /claims` - Create claim
- `POST /disputes` - Create dispute
- `PATCH /disputes/:id/*` - Update dispute
- `POST /identity/users` - Create user
- `POST /identity/users/:id/wallets` - Link wallet
- `DELETE /identity/users/:id/wallets/:chain/:address` - Unlink wallet
- All other POST/PATCH/PUT/DELETE endpoints

### Auth-Protected Endpoints
- `GET /auth/profile` - Get authenticated user profile

## Testing

Run the E2E tests:

```bash
npm run test:e2e -- auth.e2e-spec.ts
```

## Implementation Details

### File Structure

```
src/auth/
├── dto/
│   ├── challenge.dto.ts       # Challenge request DTO
│   └── login.dto.ts           # Login request DTO
├── strategies/
│   └── jwt.strategy.ts        # Passport JWT strategy
├── auth.controller.ts         # Auth endpoints
├── auth.module.ts             # Auth module
├── auth.service.ts            # Auth business logic
├── global-auth.guard.ts       # Global protection guard
├── jwt-auth.guard.ts          # Standard JWT guard
└── optional-jwt-auth.guard.ts # Optional auth guard

src/decorators/
└── public.decorator.ts        # @Public() decorator
```

### Adding Public Endpoints

To make an endpoint publicly accessible:

```typescript
import { Public } from '../decorators/public.decorator';

@Post('some-endpoint')
@Public()
async somePublicEndpoint() {
  // This endpoint is accessible without authentication
}
```

### Custom Authorization Logic

For endpoints that need custom auth logic, use the `JwtAuthGuard` directly:

```typescript
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Post('custom-endpoint')
@UseGuards(JwtAuthGuard)
async customEndpoint(@Request() req) {
  const user = req.user; // Authenticated user
  // Custom logic here
}
```

## Troubleshooting

### Common Errors

**403 Forbidden: Authentication required**
- Ensure you're including the JWT token in the Authorization header
- Check if the token has expired
- Verify the token format: `Bearer <token>`

**401 Unauthorized: Signature verification failed**
- Ensure the signature matches the address
- Verify the message hasn't been tampered with
- Check if the challenge has expired

**401 Unauthorized: Challenge expired**
- Challenges expire after 5 minutes
- Request a new challenge and sign it

**401 Unauthorized: No challenge found**
- You must request a challenge before logging in
- Each challenge is single-use

## Best Practices

1. **Store JWT securely**: Use httpOnly cookies or secure storage
2. **Handle token expiration**: Implement token refresh logic
3. **Sign messages safely**: Use established wallet libraries (ethers, web3)
4. **Validate responses**: Always check for errors in authentication responses
5. **Use HTTPS**: Never transmit tokens over unencrypted connections
