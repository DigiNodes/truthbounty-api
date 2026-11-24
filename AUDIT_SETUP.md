# Audit Trail Setup Guide

## Installation Steps

### Step 1: Database Migration

Run the TypeORM migration to create the `audit_logs` table:

```bash
# Generate migration (if using TypeORM CLI)
npm run typeorm migration:generate -- src/migrations/AddAuditLogs

# Or run the pre-created migration
npm run typeorm migration:run
```

If migrations are auto-run on startup (synchronize: true), the table will be created automatically.

### Step 2: Update Your Services

For each service that needs audit logging, inject the `AuditTrailService`:

```typescript
import { AuditTrailService } from '../audit/services/audit-trail.service';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';

@Injectable()
export class YourService {
  constructor(
    private auditTrailService: AuditTrailService,
    // ... other dependencies
  ) {}

  async yourMethod() {
    // Your implementation
    await this.auditTrailService.log({
      actionType: AuditActionType.CLAIM_CREATED,
      entityType: AuditEntityType.CLAIM,
      entityId: 'entity-id',
      userId: 'user-id',
      description: 'Action description',
      afterState: { /* entity state */ },
    });
  }
}
```

### Step 3: Using the @AuditLog Decorator (Optional)

For automatic logging with the decorator, just add it to your methods:

```typescript
import { AuditLog } from '../audit/decorators/audit-log.decorator';
import { AuditActionType, AuditEntityType } from '../audit/entities/audit-log.entity';

@AuditLog({
  actionType: AuditActionType.CLAIM_CREATED,
  entityType: AuditEntityType.CLAIM,
  descriptionTemplate: 'Claim created',
  captureAfterState: true,
})
async createClaim(data: any): Promise<Claim> {
  // Method implementation
}
```

### Step 4: Verify Installation

Test that audit logging is working:

```bash
# Start your application
npx nest start

# Make a request that triggers an audited action
curl -X POST http://localhost:3000/claims \
  -H "Content-Type: application/json" \
  -d '{"data": "..."}'

# Query the audit logs
curl http://localhost:3000/audit
```

## Common Integration Patterns

### Pattern 1: Log on Create

```typescript
async create(dto: CreateClaimDto, userId: string): Promise<Claim> {
  const entity = this.repo.create(dto);
  const saved = await this.repo.save(entity);

  await this.auditTrailService.log({
    actionType: AuditActionType.CLAIM_CREATED,
    entityType: AuditEntityType.CLAIM,
    entityId: saved.id,
    userId,
    description: `Created claim: ${saved.id}`,
    afterState: this.serializeEntity(saved),
  });

  return saved;
}
```

### Pattern 2: Log Before/After State

```typescript
async update(id: string, dto: UpdateClaimDto, userId: string): Promise<Claim> {
  const before = await this.repo.findOne(id);
  const beforeState = this.serializeEntity(before);

  Object.assign(before, dto);
  const after = await this.repo.save(before);

  await this.auditTrailService.log({
    actionType: AuditActionType.CLAIM_UPDATED,
    entityType: AuditEntityType.CLAIM,
    entityId: id,
    userId,
    description: 'Claim updated',
    beforeState,
    afterState: this.serializeEntity(after),
  });

  return after;
}
```

### Pattern 3: Log with Metadata

```typescript
async completeVerification(
  claimId: string,
  verdict: boolean,
  userId: string,
): Promise<void> {
  const claim = await this.claimRepo.findOne(claimId);

  // Perform verification
  claim.verified = true;
  claim.verdict = verdict;
  await this.claimRepo.save(claim);

  // Log with rich metadata
  await this.auditTrailService.log({
    actionType: AuditActionType.VERIFICATION_COMPLETED,
    entityType: AuditEntityType.CLAIM,
    entityId: claimId,
    userId,
    description: `Claim ${verdict ? 'verified' : 'rejected'}`,
    beforeState: { verified: false },
    afterState: { verified: true, verdict },
    metadata: {
      verificationTime: Date.now(),
      verificationMethod: 'automated',
      confidence: 0.95,
      sources: ['source1', 'source2'],
    },
  });
}
```

## Querying Audit Logs

### Get with cURL

```bash
# Get all claims related actions
curl "http://localhost:3000/audit?entityType=CLAIM"

# Get user's actions
curl "http://localhost:3000/audit/user/user-id-123"

# Get claim resolution history
curl "http://localhost:3000/audit/entity/CLAIM/claim-id-123"

# Get change history
curl "http://localhost:3000/audit/changes/CLAIM/claim-id-123"

# Get summary for last 30 days
curl "http://localhost:3000/audit/summary?entityType=CLAIM&days=30"
```

### Get with NestJS HttpClient

```typescript
import { HttpClient } from '@angular/common/http';

export class AuditService {
  constructor(private http: HttpClient) {}

  getEntityLogs(entityType: string, entityId: string) {
    return this.http.get(`/audit/entity/${entityType}/${entityId}`);
  }

  getUserLogs(userId: string) {
    return this.http.get(`/audit/user/${userId}`);
  }

  getChangeHistory(entityType: string, entityId: string) {
    return this.http.get(`/audit/changes/${entityType}/${entityId}`);
  }

  getSummary(entityType?: string, days?: number) {
    let url = '/audit/summary';
    const params = [];
    if (entityType) params.push(`entityType=${entityType}`);
    if (days) params.push(`days=${days}`);
    if (params.length) url += '?' + params.join('&');
    return this.http.get(url);
  }
}
```

## Performance Considerations

1. **Indexing** - The migration creates indexes on frequently queried fields
2. **Pagination** - Always use limit/offset for large datasets
3. **Async Logging** - Audit logging is non-blocking and won't slow requests
4. **Retention** - Consider archiving old logs periodically

## Troubleshooting

### Logs not appearing

1. Check that AuditModule is imported in AppModule
2. Verify AuditLoggingInterceptor is registered globally
3. Confirm database table was created: `SELECT * FROM audit_logs LIMIT 1`
4. Check logs for errors: Look for "Failed to log audit" messages

### Query not returning results

1. Verify the entityId, userId, or entityType values match
2. Check the format: IDs should be exact matches
3. Try querying all logs first: `GET /audit`
4. Check database directly for table content

### Performance issues

1. Add indexes to frequently filtered columns
2. Use pagination with smaller page sizes
3. Archive old logs regularly with `deleteOldLogs(daysToKeep)`
4. Consider a separate audit database for high-volume systems

## Example Workflow

Here's a complete example integrating audit logging into claim submission and verification:

```typescript
// claims.controller.ts
@Post()
async createClaim(@Body() dto: CreateClaimDto, @Request() req) {
  return this.claimsService.createClaim(dto, req.user.id);
}

@Post(':id/resolve')
async resolveClaim(
  @Param('id') claimId: string,
  @Body() dto: ResolveClaimDto,
  @Request() req,
) {
  return this.claimsService.resolveClaim(
    claimId,
    dto.verdict,
    dto.confidence,
    req.user.id,
  );
}

// claims.service.ts
@AuditLog({
  actionType: AuditActionType.CLAIM_CREATED,
  entityType: AuditEntityType.CLAIM,
  captureAfterState: true,
})
async createClaim(dto: CreateClaimDto, userId: string): Promise<Claim> {
  const claim = await this.claimRepo.save(this.claimRepo.create(dto));
  return claim;
}

async resolveClaim(
  claimId: string,
  verdict: boolean,
  confidence: number,
  userId: string,
): Promise<Claim> {
  const before = await this.claimRepo.findOne(claimId);
  before.resolvedVerdict = verdict;
  before.confidenceScore = confidence;
  const after = await this.claimRepo.save(before);

  await this.auditTrailService.log({
    actionType: AuditActionType.CLAIM_RESOLVED,
    entityType: AuditEntityType.CLAIM,
    entityId: claimId,
    userId,
    description: `Resolved: ${verdict}, confidence: ${confidence}`,
    beforeState: { verdict: before.resolvedVerdict, confidence: before.confidenceScore },
    afterState: { verdict, confidence },
  });

  return after;
}

// Query the audit trail
const logs = await this.auditTrailService.getEntityAuditLogs(
  AuditEntityType.CLAIM,
  claimId,
);
```

## Next Steps

1. **Add audit logging to more services** - Extend to user management, rewards, etc.
2. **Create audit reports** - Build compliance and analytics tools
3. **Set up monitoring** - Alert on suspicious patterns
4. **Implement retention policies** - Archive old logs periodically
5. **Create dashboards** - Visualize audit activity over time
