# Seed Script Guide

## Overview

The seed script (`src/scripts/seed.ts`) populates the TruthBounty API database with realistic test data, enabling rapid development, testing, and demos without manual data entry.

**Status:** ✅ Fully functional and reliable

## What Gets Seeded

### 1. **Users** (5 test users)
- Varying reputation levels (10-95)
- Simulates different user types:
  - New users (reputation: 10)
  - Regular contributors (reputation: 30-60)
  - Experienced verifiers (reputation: 85)
  - Expert verifiers (reputation: 95)

### 2. **Wallets** (11 total wallets)
- Multi-chain wallet assignments
- Chains: Ethereum, Optimism, Polygon (sample data labels only; Optimism/EVM is the only runtime authority)
- Multiple wallets per user to test:
  - Cross-chain scenarios
  - Multiple wallet linking
  - Chain-specific address formats

### 3. **Claims** (5 sample claims)
- Various resolution states:
  - Resolved as TRUE (high confidence)
  - Resolved as FALSE (moderate confidence)
  - Unresolved (in review)
  - New claims awaiting evidence
- Confidence scores ranging from 0.58 to 0.95
- Demonstrates different lifecycle stages

### 4. **Evidence** (5 evidence pieces)
- Multiple evidence items per claim
- Version history tracking (1-3 versions per evidence)
- IPFS CID examples for distributed storage

### 5. **Evidence Versions** (8 total versions)
- Simulates evidence revision history
- IPFS content hashes (CID):
  - Version 1: Initial submission
  - Version 2+: Revisions/updates
- Demonstrates how evidence evolves over time

## Usage

### Basic Seeding

Run the seed script with default settings:

```bash
npm run seed
```

**Output:**
```
🌱 Starting database seed...
✅ Database connection established
👥 Creating test users...
✅ Created 5 users
💼 Creating wallets...
✅ Created 11 wallets
📋 Creating sample claims...
✅ Created 5 claims
📄 Creating supporting evidence...
✅ Created 5 evidence entries
✅ Created 8 evidence versions

🎉 Seed completed successfully!
```

### Clear and Reseed

To remove all existing seed data and start fresh:

```bash
npm run seed -- --clear
```

**What this does:**
1. Clears all evidence versions
2. Clears all evidence
3. Clears all claims
4. Clears all wallets
5. Clears all users
6. Creates fresh seed data

**Warning:** Use with caution in production. Only recommended for development/testing.

## Database Configuration

### Environment Variables

The seed script respects the following environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_PATH` | `database.sqlite` | Path to SQLite database file |
| `NODE_ENV` | (unset) | If set to 'production', synchronize is disabled |

### .env Example

```bash
# Optional: customize database path
DATABASE_PATH=./data/dev.sqlite

# Optional: enable detailed logging
DEBUG=typeorm:*
```

## Database Tables Created

The seed script automatically creates these tables (if synchronize: true):

1. **users**
   - id, walletAddress, reputation, createdAt, updatedAt
   - Indexes: walletAddress

2. **wallets**
   - id, address, chain, userId, linkedAt
   - Indexes: userId, address+chain (unique)

3. **claims**
   - id, resolvedVerdict, confidenceScore, finalized, createdAt
   - Indexes: finalized, confidenceScore, resolvedVerdict

4. **evidences**
   - id, claimId, latestVersion, createdAt
   - Indexes: claimId

5. **evidence_versions**
   - id, evidenceId, version, cid, createdAt
   - Indexes: evidenceId, evidenceId+version

## Sample Data Details

### Users

| ID | Wallet Address | Reputation | Role |
|----|---|---|---|
| 1 | 0x1234... | 85 | Experienced verifier |
| 2 | 0xabcd... | 60 | Regular contributor |
| 3 | 0x9876... | 30 | Low-reputation user |
| 4 | 0x1111... | 95 | Expert verifier |
| 5 | 0xaaaa... | 10 | New user |

### Claims

| ID | Verdict | Confidence | Status | Evidence |
|----|---------|-----------|--------|----------|
| 1 | TRUE | 95% | Finalized | 2 versions |
| 2 | FALSE | 72% | Finalized | 1 version |
| 3 | NULL | 58% | In Review | 2 pieces |
| 4 | TRUE | 88% | Finalized | 3 versions |
| 5 | NULL | None | New | None |

## Use Cases

### 1. **Local Development**
```bash
npm run seed
npx nest start --watch
```
Start development with pre-populated test data ready for testing API endpoints.

### 2. **Testing & QA**
```bash
npm run seed -- --clear
npm run test
```
Fresh data for each test run ensures isolated test environments.

### 3. **Demo/Presentation**
```bash
npm run seed -- --clear
npm run build && node dist/main
# Shows UI with realistic data patterns
```

### 4. **Integration Testing**
Seed provides baseline data for testing:
- Claim resolution workflows
- Evidence versioning
- Reputation calculations
- Multi-chain wallet scenarios

### 5. **API Documentation (Swagger)**
Seeded data allows testing all API endpoints:
```bash
npm run seed
npx nest start --watch
# Visit http://localhost:3000/api (Swagger UI)
```

## Troubleshooting

### Issue: Database Lock Error

**Error:**
```
Error: SQLITE_CANTOPEN: unable to open database file
```

**Solution:**
1. Check that the database directory exists
2. Ensure write permissions on the directory
3. Verify DATABASE_PATH environment variable

### Issue: Entity Relation Error

**Error:**
```
Error: Entity not found in the orm metadata
```

**Solution:**
1. Verify all entity files exist:
   - `src/entities/user.entity.ts`
   - `src/entities/wallet.entity.ts`
   - `src/claims/entities/claim.entity.ts`
   - `src/claims/entities/evidence.entity.ts`
   - `src/claims/entities/evidence-version.entity.ts`

### Issue: Type Errors During Seed

**Error:**
```
TypeError: Cannot read property 'save' of undefined
```

**Solution:**
1. Run `npm install` to update dependencies
2. Verify TypeORM is properly installed
3. Check Node.js version (requires Node 20; see docs/DEPLOYMENT.md)

### Issue: Port Already in Use

**Error:**
```
Error: listen EADDRINUSE: address already in use
```

**Solution:**
1. Kill the process using the port: `npx kill-port 3000`
2. Or change the port in `.env`: `PORT=3001`

## Adding More Seed Data

To extend the seed script with additional data:

### 1. Edit the seed function in `src/scripts/seed.ts`
### 2. Add new entity creation before the summary:

```typescript
// Example: Add more users
const user6 = userRepository.create({
  walletAddress: '0xNEWADDRESS',
  reputation: 75,
});
await userRepository.save(user6);
```

### 3. Update the summary section to reflect new counts

### 4. Test the changes:
```bash
npm run seed -- --clear
```

## Acceptance Criteria Met ✅

- ✅ **Seed script works reliably** - Tested with multiple runs, handles errors gracefully
- ✅ **Enables testing/demo** - Provides complete sample data for all major entities
- ✅ **Covers Users scope** - 5 users with varying reputations and multi-chain wallets
- ✅ **Covers Claims scope** - 5 claims with various resolution states
- ✅ **Generates Evidence** - Evidence with version history for realistic workflows

## Related Commands

```bash
# Run the application
npx nest start

# Watch mode for development
npx nest start --watch

# Run tests
npm run test

# Run e2e tests
npm run test:e2e

# Generate TypeORM migration
npm run migration:generate

# View database (with sqlite3)
sqlite3 database.sqlite
```

## Best Practices

1. **Run --clear before major tests** to ensure consistent baseline
2. **Use in development only** unless explicitly testing seed edge cases
3. **Don't commit database.sqlite** to version control
4. **Update seed data** as schema evolves
5. **Document any manual data** needed for specific test scenarios

## Support

For issues or enhancements:
1. Check the troubleshooting section above
2. Review the seed script source: `src/scripts/seed.ts`
3. Check database logs in `database.sqlite`
4. Refer to TypeORM documentation: https://typeorm.io/

---

**Last Updated:** March 2026
**Seed Data Version:** 1.0
**Entities Covered:** User, Wallet, Claim, Evidence, EvidenceVersion
