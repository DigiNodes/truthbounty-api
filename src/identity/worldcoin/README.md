# Worldcoin ID Integration

This module provides Worldcoin ID verification capabilities for TruthBounty, enabling Sybil-resistant identity verification without storing personal information.

## Features

- ✅ Worldcoin proof verification using ZK proofs
- ✅ Duplicate proof prevention via nullifier hash tracking
- ✅ Secure storage of verification metadata
- ✅ API endpoints for verification and status checking
- ✅ Privacy-preserving (no PII stored)

## API Endpoints

### POST `/identity/worldcoin/verify`
Verifies a user using Worldcoin ID.

**Request Body:**
```json
{
  "userId": "user-123-abc",
  "proof": {
    "merkle_root": "0x...",
    "nullifier_hash": "0x...",
    "proof": "0x...",
    "verification_level": "orb"
  },
  "action": "truthbounty-verify",
  "signal": "optional-user-data"
}
```

**Response:**
```json
{
  "success": true,
  "verification": {
    "id": "verification-uuid",
    "userId": "user-123-abc",
    "verificationLevel": "orb",
    "verifiedAt": "2024-01-23T10:30:00Z"
  }
}
```

### GET `/identity/worldcoin/status/:userId`
Gets verification status for a user.

**Response:**
```json
{
  "verified": true,
  "verification": {
    "id": "verification-uuid",
    "verificationLevel": "orb",
    "verifiedAt": "2024-01-23T10:30:00Z"
  }
}
```

### GET `/identity/worldcoin/verification/:nullifierHash`
Looks up verification by nullifier hash.

**Response:**
```json
{
  "found": true,
  "verification": {
    "id": "verification-uuid",
    "userId": "user-123-abc",
    "verificationLevel": "orb",
    "verifiedAt": "2024-01-23T10:30:00Z"
  }
}
```

## Setup

1. **Environment Variables:**
   ```bash
   # Add to your .env file
   WORLDCOIN_APP_ID=your_app_id
   WORLDCOIN_ACTION=your_action_id
   ```

2. **Database Setup:**
   - The `WorldIdVerification` entity will be automatically created
   - Table includes indexes for performance on userId and nullifierHash

3. **Worldcoin Developer Setup:**
   - Create a Worldcoin Developer account
   - Create an application and get your App ID
   - Create an action for your specific use case

## Security Features

- **Nullifier Hash Uniqueness:** Prevents reuse of Worldcoin proofs
- **Proof Verification:** All proofs are cryptographically verified
- **No PII Storage:** Only verification metadata is stored
- **Configurable Actions:** Different actions for different use cases

## Usage in Protocol Logic

The verification status can be used for:
- Reputation system weighting
- Voting eligibility
- Reward distribution
- Sybil resistance mechanisms

```typescript
// Check if user is verified
const isVerified = await worldcoinService.isUserVerified(userId);

// Get verification details
const verification = await worldcoinService.getVerificationStatus(userId);
```

## Testing

Run the Worldcoin tests:
```bash
npm test -- --testPathPattern=worldcoin
```

## Database Schema

The `world_id_verifications` table contains:
- `id`: UUID primary key
- `user_id`: Associated user identifier
- `nullifier_hash`: Unique Worldcoin nullifier (indexed)
- `verification_level`: Worldcoin verification level
- `worldcoin_app_id`: App ID used for verification
- `worldcoin_action`: Action used for verification
- `verified_at`: Timestamp of verification
- `merkle_root`: Merkle root from proof
- `proof`: Full proof data (JSON)
