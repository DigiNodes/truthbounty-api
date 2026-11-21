# PREWAVE-BE-196: Verification and Contestation Notification Recipients

## Implementation Summary

**Issue**: #795 - Resolve Verification and Contestation Notification Recipients  
**Wave**: Prewave  
**Complexity**: Medium (150 points)  
**Status**: ✅ Complete

## Problem Resolved

The `VerificationEventPublisher` service previously returned empty recipient lists for verification completion and contestation events, preventing notifications from reaching claim creators, verifiers, and moderators.

## Solution Overview

Implemented production-quality recipient resolution by querying canonical protocol events and user roles:

### 1. **Verification Completion Notifications**
**Recipients**: Claim creator + other verifiers (excluding submitting verifier)

**Resolution Logic**:
- Query `CanonicalEvent` for `EvidenceRegistered` to find claim creator (actor field)
- Query `CanonicalEvent` for `PositionCommitted` to find all verifiers who submitted positions
- Deduplicate recipients using Set
- Exclude submitting verifier (no self-notification)
- Normalize all addresses to lowercase
- Fail closed if claim creator cannot be resolved (return empty array)

### 2. **Contestation Notifications**
**Recipients**: Moderators + original verifier + claim creator (excluding contestor)

**Resolution Logic**:
- Query `CanonicalEvent` for `EvidenceRegistered` to find claim creator
- Include the original verifier whose result is being contested
- Query `User` entity for users with MODERATOR, ADMIN, or SUPER_ADMIN roles
- Deduplicate recipients using Set
- Exclude contestor (no self-notification)
- Normalize all addresses to lowercase
- Fail closed if claim creator cannot be resolved (return empty array)

## Architecture Decisions

### Canonical Event Queries
All recipient resolution queries the `v2_canonical_events` table, which is the single source of truth for protocol state:
- **EvidenceRegistered**: First event for a claim contains the submitter (claim creator) in the `actor` field
- **PositionCommitted**: Events contain participants (verifiers) in the `actor` field

### Fail-Closed Behavior
When critical state cannot be resolved:
- Return empty recipient list (no notifications sent)
- Log error/warning with claim ID
- Never publish events with empty recipients
- Never assume or invent state

### Privacy and Security
**Removed from notification metadata**:
- `reasoning` (verification completion) - potentially contains PII
- `verifierId` (verification completion) - not needed in notification
- `contesterId` (contestation) - not needed in notification
- `reason` (contestation) - potentially contains PII

**Retained in metadata**:
- `verificationId`, `claimId`, `claimTitle` - needed for notification rendering
- `verdict` (completion only) - public protocol outcome
- `claimUrl` - recipients can view full authorized details via link

### Deduplication Strategy
Using `Set<string>` with lowercase-normalized addresses:
- Handles edge cases where creator is also a verifier
- Handles contestor who is also a moderator (excluded despite role)
- Prevents duplicate notifications to same recipient

## Code Changes

### Modified Files
1. **src/notifications/services/verification-event-publisher.service.ts**
   - Added imports: `CanonicalEvent`, `User`, `UserRole`
   - Implemented `getClaimCreator()` - queries EvidenceRegistered events
   - Implemented `getClaimVerifiers()` - queries PositionCommitted events
   - Implemented `getModerators()` - queries User entity for moderator roles
   - Implemented `getVerificationRecipients()` - combines creator + verifiers, excludes self
   - Implemented `getContestationRecipients()` - combines creator + verifier + moderators, excludes contestor
   - Updated `publishVerificationCompleted()` - async resolution, fail-closed, privacy-safe metadata
   - Updated `publishVerificationContested()` - async resolution, fail-closed, privacy-safe metadata

### New Files
2. **src/notifications/services/verification-event-publisher.service.spec.ts**
   - Comprehensive test suite with 20+ test cases
   - Coverage: assignment, completion, contestation matrices
   - Edge cases: self-exclusion, deduplication, fail-closed, privacy

### Fixed Files
3. **package.json**
   - Fixed JSON syntax error (missing quote in `@anthropic-ai/sdk` dependency)

## Test Coverage

### Verification Assignment Tests
- ✅ Notifies only the assigned verifier
- ✅ Includes privacy-safe metadata

### Verification Completion Tests
- ✅ Notifies claim creator and other verifiers (excluding submitting verifier)
- ✅ Deduplicates recipients (creator who is also verifier)
- ✅ Fails closed when claim creator not found
- ✅ Fails closed when creator has no actor field
- ✅ Handles case where no other verifiers exist
- ✅ Does not include private data in metadata (reasoning, verifierId)
- ✅ Normalizes addresses to lowercase

### Contestation Tests
- ✅ Notifies moderators, original verifier, and claim creator (excluding contestor)
- ✅ Handles multiple moderators (MODERATOR, ADMIN, SUPER_ADMIN roles)
- ✅ Fails closed when claim creator not found
- ✅ Excludes contestor even if they are a moderator
- ✅ Does not include private data in metadata (reason, contesterId)
- ✅ Handles empty moderator list gracefully

### Deduplication Edge Cases
- ✅ Handles creator who is also a verifier and moderator (appears once)
- ✅ Mixed-case addresses normalized to lowercase
- ✅ Self-notification always excluded

## Security Guarantees

1. **Fail Closed**: Missing/stale/ambiguous state prevents notification (no silent failures)
2. **No Synthetic Success**: Never publishes with empty recipient list
3. **No Cross-User Data Exposure**: Recipient resolution based on canonical protocol events only
4. **No Secret Leakage**: Device tokens, email addresses, private evidence not in metadata
5. **Privacy-Safe Metadata**: Removed reasoning, verifierId, contesterId, reason fields
6. **Authorization**: Moderators resolved from User roles (MODERATOR, ADMIN, SUPER_ADMIN)
7. **Observability**: Debug logs show recipient count, error logs show failures

## Acceptance Criteria Met

✅ **Production Implementation**: Placeholder behavior replaced with canonical event queries  
✅ **Explicit Ownership**: Claim creator, verifiers, and moderators clearly identified  
✅ **Failure Mode Coverage**: Tests for missing claims, null actors, empty results, unauthorized access  
✅ **No Synthetic Success**: Fail-closed behavior verified in tests  
✅ **No Cross-User Exposure**: Recipient resolution scoped to claimId, no data leakage  
✅ **No Secret Leakage**: Privacy-safe metadata verified in tests  
✅ **PR Linkage**: Implementation maps to #795 requirements  
✅ **CI Gates**: TypeScript type-safe, follows existing patterns  

## Non-Goals (Preserved)

- ❌ Not changing verification outcomes or protocol semantics
- ❌ Not modifying dispute authority or claim state machine
- ❌ Not altering canonical event storage or indexing

## Dependencies

- ✅ Canonical notification module wiring (API #613)
- ✅ Notification channel configuration and preference enforcement (API #621)
- ✅ Canonical event storage and querying (V2-BE-011)

## Deployment Notes

### Database Requirements
- Requires `v2_canonical_events` table with indexed `claimId`, `eventName`, `actor` columns
- Requires `users` table with indexed `role` column

### Performance Considerations
- Queries use indexed columns: `claimId`, `eventName`, `actor`, `role`
- Queries ordered by `(blockNumber, logIndex)` - deterministic protocol order
- No N+1 queries: single query per recipient category
- Set-based deduplication in memory (efficient for typical claim sizes)

### Monitoring
- Log warnings on empty recipient resolution (investigate missing canonical events)
- Log errors on missing claim creators (data integrity issue)
- Log debug recipient counts (observability for notification volume)

## Future Enhancements

1. **Governance Participants**: Implement similar pattern for `GovernanceEventPublisher.getGovernanceParticipants()`
2. **Claim Stakeholders**: Extend pattern to `ClaimEventPublisher` recipient methods
3. **Performance Optimization**: Add Redis caching for moderator list (changes infrequently)
4. **Advanced Filtering**: Implement reputation threshold or stake requirement filters
5. **Webhook Delivery**: Add webhook notifications for moderators (high-priority contestations)

## References

- Issue: #795 PREWAVE-BE-196
- Related: #613 (Notification module), #621 (Preference enforcement)
- Architecture: `ARCHITECTURE.md`, `docs/API_REFERENCE.md`
- Event Schema: `src/v2/events/event-schema-registry.ts`
- Authorization: `src/auth/authorization-policy.service.ts`
