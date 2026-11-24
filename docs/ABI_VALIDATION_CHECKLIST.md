# ABI Validation Production Readiness - Deployment Checklist

## Pre-Deployment Validation

### Code Review
- [ ] Review `AbiValidationService` implementation
- [ ] Review `VersionCompatibilityService` implementation
- [ ] Review `ContractManifestValidatorService` integration
- [ ] Review `EventDecoderService` signature keying changes
- [ ] Review database migration script

### Testing
- [ ] All unit tests passing (`npm test`)
- [ ] Integration tests passing (`npm test -- event-overload`)
- [ ] Manifest validation tests passing
- [ ] Version compatibility tests passing
- [ ] No regression in existing event decoding tests

### Documentation
- [ ] `ABI_VALIDATION_PRODUCTION_READINESS.md` reviewed
- [ ] `ABI_VALIDATION_QUICK_REFERENCE.md` reviewed
- [ ] Example manifest validated
- [ ] Migration runbook prepared

## Manifest Updates

### Current Manifests
- [ ] Add `topic0` to all events (null for anonymous)
- [ ] Add `signature` to all events
- [ ] Add `anonymous` flag to all events
- [ ] Add `indexed` metadata to all events
- [ ] Regenerate and validate all checksums
- [ ] Verify against validation service locally

### New Manifest Template
```json
{
  "name": "EventName",
  "abi": "event EventName(...)",
  "topic0": "0x...",
  "signature": "EventName(...)",
  "anonymous": false,
  "indexed": [
    { "name": "param", "type": "address", "position": 0 }
  ]
}
```

### Validation Commands
```bash
# Validate all manifests
npm run validate:manifests

# Check for collisions
npm run check:collisions

# Verify checksums
npm run verify:checksums
```

## Database Migration

### Pre-Migration
- [ ] Backup production database
- [ ] Test migration on staging environment
- [ ] Verify rollback procedure
- [ ] Estimate migration time
- [ ] Schedule maintenance window if needed

### Migration Execution
- [ ] Run migration: `npm run migration:run`
- [ ] Verify column added: `eventSignature`
- [ ] Verify index created: `idx_v2_canonical_event_signature`
- [ ] Verify backfill completed (all rows have eventSignature)
- [ ] Check migration logs for errors

### Post-Migration
- [ ] Query sample rows to verify data
- [ ] Check index performance
- [ ] Verify no NULL values in eventSignature (except pre-existing)
- [ ] Run validation tests against migrated database

## CI/CD Updates

### GitHub Actions
- [ ] Add manifest validation step
- [ ] Add ABI compatibility check
- [ ] Configure failure on validation errors
- [ ] Configure warnings for non-blocking issues
- [ ] Test CI pipeline with intentional validation failure

### Configuration
```yaml
- name: Validate Manifests
  run: npm run validate:manifests
  
- name: ABI Compatibility
  run: npm test -- --testPathPattern=abi-validation
```

## Environment Configuration

### Required Variables
- [ ] `MANIFEST_VALIDATION` (default: enabled)
- [ ] `MANIFEST_MAX_AGE_DAYS` (default: 90)
- [ ] `BLOCKCHAIN_STARTUP_RPC_CHECK` (default: enabled)
- [ ] `NODE_ENV` (production/development/test)

### Staging Environment
- [ ] Configure with test manifests
- [ ] Enable all validation checks
- [ ] Test with overloaded events
- [ ] Test with anonymous events
- [ ] Verify version pinning

### Production Environment
- [ ] Configure with production manifests
- [ ] Enable all validation checks
- [ ] Verify version matches deployment
- [ ] Confirm release ID is set

## Deployment Steps

### 1. Deploy to Staging
- [ ] Deploy code with new validation
- [ ] Verify startup validation runs
- [ ] Check logs for any warnings
- [ ] Test event decoding
- [ ] Test manifest updates
- [ ] Verify version compatibility checks

### 2. Smoke Tests
- [ ] Decode known events successfully
- [ ] Verify overloaded events decode correctly
- [ ] Check quarantine for unexpected entries
- [ ] Verify performance (validation overhead)
- [ ] Check memory usage

### 3. Deploy to Production
- [ ] Deploy during maintenance window
- [ ] Monitor startup logs for validation
- [ ] Verify pinned release logged
- [ ] Check for validation errors
- [ ] Monitor event decoding
- [ ] Watch quarantine table

### 4. Post-Deployment
- [ ] Verify all contracts validated
- [ ] Check event decoding rates
- [ ] Monitor for unknown topics
- [ ] Review any warnings
- [ ] Confirm no errors in logs

## Monitoring

### Metrics to Track
- [ ] Manifest validation success rate
- [ ] Event decode success rate
- [ ] Quarantine entry rate
- [ ] Unknown topic frequency
- [ ] Validation performance (time)

### Alerts to Configure
- [ ] Validation failure at startup
- [ ] Unexpected quarantine rate increase
- [ ] Version mismatch detected
- [ ] Unknown topics from known contracts

### Dashboards
- [ ] Event decoding by signature
- [ ] Quarantine reasons breakdown
- [ ] Version compatibility status
- [ ] Manifest validation metrics

## Rollback Plan

### Triggers
- Validation prevents startup
- High quarantine rate
- Event decoding failures
- Performance degradation
- Database issues

### Rollback Steps
1. [ ] Revert application deployment
2. [ ] If needed, rollback database migration
3. [ ] Restore previous manifest version
4. [ ] Verify old version operational
5. [ ] Document issue for post-mortem

### Rollback Validation
- [ ] Application starts successfully
- [ ] Events decode correctly
- [ ] No data loss
- [ ] Services operational

## Verification

### Post-Deployment Checks
```bash
# Check validation logs
kubectl logs <pod> | grep "Contract manifest.*validated"

# Verify pinned release
kubectl logs <pod> | grep "Decoder locked to pinned manifest"

# Check for errors
kubectl logs <pod> | grep "ERROR"

# Monitor quarantine
psql -c "SELECT reason, COUNT(*) FROM v2_event_quarantine GROUP BY reason"

# Check recent events
psql -c "SELECT eventName, eventSignature, COUNT(*) FROM v2_canonical_events WHERE ingestedAt > NOW() - INTERVAL '1 hour' GROUP BY eventName, eventSignature"
```

### Success Criteria
- [ ] All contracts validated at startup
- [ ] Zero validation errors in logs
- [ ] Pinned release version logged correctly
- [ ] Events decoding with signatures
- [ ] Quarantine rate unchanged or lower
- [ ] No performance degradation

## Documentation Updates

### Update After Deployment
- [ ] Record deployment date in CHANGELOG
- [ ] Update API documentation with new fields
- [ ] Update operator runbooks
- [ ] Add monitoring dashboards to docs
- [ ] Update troubleshooting guide with new scenarios

## Training

### Team Preparation
- [ ] Share documentation with team
- [ ] Review validation error messages
- [ ] Demonstrate manifest generation
- [ ] Show debugging procedures
- [ ] Schedule Q&A session

## Sign-Off

### Approvals Required
- [ ] Engineering Lead
- [ ] DevOps Lead
- [ ] QA Lead
- [ ] Product Owner

### Final Checks
- [ ] All checklist items completed
- [ ] All tests passing
- [ ] Documentation complete
- [ ] Rollback plan tested
- [ ] Team trained
- [ ] Monitoring configured

---

**Deployment Date:** _________________  
**Deployed By:** _________________  
**Approved By:** _________________  

## Notes

Use this section to record any deployment-specific notes, issues encountered, or deviations from the plan.
