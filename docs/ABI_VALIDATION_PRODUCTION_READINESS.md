# ABI Validation Production Readiness

**Status:** Implemented (Post-Wave-9)  
**Dependencies:** #599, Contracts #676  
**Scope:** Production-grade ABI validation with overload support, collision detection, and version pinning

## Overview

This document describes the comprehensive ABI validation system that extends basic manifest validation to production-readiness standards. The system ensures events are keyed by canonical signature/topic0, detects incompatible drift, and enforces decoder version compatibility.

## Technical Scope

### Core Features

1. **Overload Detection and Validation**
   - Detects events with same name but different signatures
   - Validates each overload has distinct topic0
   - Keys events by canonical signature instead of name alone

2. **Collision Detection**
   - Topic0 collision detection (different events, same hash)
   - Selector collision detection (function signatures)
   - Fails closed on any collision

3. **Anonymous Event Handling**
   - Detects events with `anonymous` keyword
   - Validates anonymous events have null topic0
   - Flags for explicit review (warnings, not errors)

4. **Duplicate Detection**
   - Identifies identical event signatures appearing multiple times
   - Treats duplicates as hard errors (manifest generation bug)

5. **Indexed Field Layout Validation**
   - Validates indexed parameter count, order, and types
   - Detects mutations that break log decoding compatibility
   - Ensures stable topic layout across versions

6. **Version Compatibility**
   - Decoder locked to pinned manifest version
   - Rejects stale, ambiguous, or unauthorized ABIs
   - Validates release binding (chain ID, deployment block, checksums)

## Architecture

### Service Components

#### AbiValidationService (`src/contracts/abi-validation.service.ts`)

Production-grade ABI validation with comprehensive detection:

```typescript
// Overload detection
detectEventOverloads(abi: string[]): OverloadDetectionResult

// Collision detection
detectCollisions(abi: string[]): CollisionDetectionResult

// Anonymous event detection
detectAnonymousEvents(abi: string[]): AnonymousEventDetectionResult

// Duplicate detection
detectDuplicates(abi: string[]): DuplicateDetectionResult

// Indexed field validation
validateIndexedFieldLayout(oldAbi: string, newAbi: string): IndexedFieldValidationResult

// Comprehensive validation
validateManifestEventSet(abi: string[]): { valid: boolean; warnings: string[]; errors: string[] }
```

#### VersionCompatibilityService (`src/contracts/version-compatibility.service.ts`)

Ensures decoder uses only pinned release ABIs:

```typescript
// Validate decoder-manifest version compatibility
validateDecoderCompatibility(
  manifestVersion: string,
  manifestReleaseId: string | undefined,
  decoderVersion: string
): VersionCompatibilityResult

// Runtime artifact version check
isCompatibleArtifactVersion(artifactVersion: string, expectedVersion: string): boolean

// Validate release binding
validateReleaseBinding(manifest: ContractAddressManifest): VersionCompatibilityResult
```

#### Enhanced ContractManifestValidatorService

Integrates all validation checks into manifest validation:

- Validates anonymous flags match ABI
- Validates signatures match ABI-derived values
- Validates indexed parameters metadata
- Runs comprehensive ABI validation (overloads, collisions, duplicates)
- Reports errors and warnings separately

### Event Keying Changes

#### EventDecoderService Updates

Events now keyed by canonical signature/topic0:

```typescript
export type DecodeResult =
  | { status: 'decoded'; description: LogDescription; signature: string; topic0: string | null }
  | { status: 'unknown_signature'; topic0: string | null }
  | { status: 'decode_error'; error: string; topic0: string | null };
```

The `normalize` method now accepts signature parameter for overload disambiguation:

```typescript
normalize(
  log: RawLog,
  artifactVersion: string,
  description: LogDescription,
  signature: string, // NEW
): NormalizeResult
```

#### Database Schema Updates

New `eventSignature` column in `v2_canonical_events`:

```sql
ALTER TABLE v2_canonical_events
ADD COLUMN eventSignature VARCHAR(256) NULL;

CREATE INDEX idx_v2_canonical_event_signature 
ON v2_canonical_events (eventSignature);
```

Migration: `src/migrations/1769900000000-AddEventSignatureColumn.ts`

## Manifest Schema Extensions

### ManifestEventFragment Interface

Extended with production-required fields:

```typescript
export interface ManifestEventFragment {
  name: string;
  abi: string;
  topic0?: string | null;        // Required (post-Wave-9), null for anonymous
  anonymous?: boolean;             // Required (post-Wave-9)
  signature?: string;              // Required (post-Wave-9)
  indexed?: IndexedParameterMetadata[]; // Required (post-Wave-9)
}

export interface IndexedParameterMetadata {
  name: string;
  type: string;
  position: number;
}
```

### Example Manifest Entry

```json
{
  "name": "ClaimSubmitted",
  "abi": "event ClaimSubmitted(bytes32 indexed claimId, address indexed author, string contentURI)",
  "topic0": "0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9",
  "signature": "ClaimSubmitted(bytes32,address,string)",
  "anonymous": false,
  "indexed": [
    { "name": "claimId", "type": "bytes32", "position": 0 },
    { "name": "author", "type": "address", "position": 1 }
  ]
}
```

## Validation Rules

### Errors (Fail Closed)

The following conditions cause validation failure and prevent application startup:

1. **Topic0 Collisions**: Different events hashing to same topic0
2. **Selector Collisions**: Different functions with same selector
3. **Duplicate Signatures**: Identical event signature appearing multiple times
4. **Topic0 Mismatch**: Declared topic0 doesn't match ABI-derived value
5. **Anonymous Flag Mismatch**: Manifest flag doesn't match ABI
6. **Signature Mismatch**: Declared signature doesn't match ABI
7. **Indexed Parameter Mismatch**: Metadata doesn't match ABI
8. **Version Mismatch**: Decoder version doesn't match manifest version

### Warnings (Non-Blocking)

The following conditions are logged as warnings but don't prevent startup:

1. **Event Overloads**: Same name, different signatures (valid, requires signature-based keying)
2. **Anonymous Events**: Explicit review required for decoding
3. **Non-Standard Release ID**: Format doesn't match `rel-<network>-<date>-v<num>`
4. **Pre-Release in Production**: Using `-rc`, `-beta`, etc. versions in production

## Testing Requirements

### Unit Tests

1. ✅ `AbiValidationService` comprehensive test suite
   - Overload detection (same name, different params)
   - Collision detection (topic0, selectors)
   - Anonymous event detection
   - Duplicate detection
   - Indexed field layout validation

2. ✅ `VersionCompatibilityService` test suite
   - Version matching (exact, mismatch)
   - Release binding validation
   - Artifact version runtime checks

3. ✅ `ContractManifestValidatorService` updated tests
   - Integration with `AbiValidationService`
   - Warnings vs errors reporting

### Integration Tests

1. ✅ Event overload decoding tests (`event-overload.integration.spec.ts`)
   - Decode overloaded events with correct signatures
   - Distinguish by topic0
   - Fail when using wrong ABI version

2. ⏳ Anonymous event tests
   - Decode anonymous events (no topic0)
   - Validate indexed parameter handling (up to 4 indexed)

3. ⏳ Removed event detection tests
   - Events in old ABI but not in new ABI
   - Proper drift detection and quarantine

4. ⏳ Indexed layout mutation tests
   - Type changes in indexed parameters
   - Reordering of indexed parameters
   - Count changes

## CI Integration

### Validation Gates

All validation must pass before deployment:

```yaml
# .github/workflows/ci.yml
- name: Validate Contract Manifests
  run: npm run validate:manifests

- name: ABI Compatibility Check
  run: npm run test:abi-validation
```

### Incompatible Drift Detection

CI fails on:
- Stale manifests (older than `MANIFEST_MAX_AGE_DAYS`)
- Version mismatches
- Topic0/selector collisions
- Duplicate or removed events without migration
- Missing required fields (topic0, signature, indexed, anonymous)

## Security Constraints

### Fail-Closed Design

- **No Fallbacks**: Missing or invalid ABIs never fall back to defaults
- **No Guessing**: Unknown topics remain quarantined, never assumed
- **No Silent Mutations**: Layout changes fail validation explicitly
- **No Alternate Versions**: Only the pinned manifest version is accepted

### Audit Requirements

1. All chain-derived data bound to:
   - Chain ID
   - Release ID
   - Deployment block
   - Artifact checksum

2. Canonical contracts/finalized events remain authoritative
3. Privacy, typing, auditability not weakened

## Usage

### Manifest Generation

When generating manifests, include all required fields:

```typescript
import { ethers } from 'ethers';
import { AbiValidationService } from './src/contracts/abi-validation.service';

const abiValidation = new AbiValidationService();

// For each event
const fragment = ethers.EventFragment.from(eventAbi);
const topic0 = fragment.anonymous ? null : ethers.id(fragment.format('sighash'));
const signature = fragment.format('sighash');
const indexed = abiValidation.extractIndexedParameters(eventAbi);

const manifestEvent = {
  name: fragment.name,
  abi: eventAbi,
  topic0,
  signature,
  anonymous: fragment.anonymous,
  indexed,
};
```

### Decoder Usage

The decoder automatically uses canonical signatures:

```typescript
const decoded = eventDecoder.decode(log, iface);
if (decoded.status === 'decoded') {
  // Signature included for overload disambiguation
  console.log('Event signature:', decoded.signature);
  console.log('Topic0:', decoded.topic0);
}
```

### Version Pinning

Validate version compatibility at startup:

```typescript
const versionCheck = versionCompatibility.validateDecoderCompatibility(
  manifest.version,
  manifest.releaseId,
  DECODER_VERSION
);

if (!versionCheck.compatible) {
  throw new Error(`Version incompatible: ${versionCheck.errors.join(', ')}`);
}

versionCompatibility.logPinnedRelease(
  manifest.version,
  manifest.releaseId,
  manifest.chainId,
  manifest.contracts.length
);
```

## Migration Path

### Existing Manifests

1. **Add New Fields**: Run migration tool to populate `signature`, `anonymous`, `indexed` for all events
2. **Validate**: Run `npm run validate:manifests` to check for issues
3. **Backfill**: Update `eventSignature` in database with migration
4. **Deploy**: New code validates enhanced manifests

### Backward Compatibility

- New fields are optional during transition period
- Warnings (not errors) for missing fields until cutover date
- After cutover: missing fields are hard errors

## References

- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- [API_REFERENCE.md](./API_REFERENCE.md) - API endpoints
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment procedures
- Post-Wave-9 Production Readiness Audit
- Issue #599 - ABI Validation Tracking
- Contracts #676 - Release Artifacts

## Acceptance Criteria

✅ Events are keyed by canonical signature/topic, not name alone  
✅ Incompatible drift fails CI  
✅ Decoder selects the pinned release ABI only  
✅ Unknown topics remain quarantined  
✅ Overload, anonymous, duplicate, collision tests passing  
✅ Indexed field layout/type mutation detection working  
⏳ Removed event tests (in progress)  
⏳ CI gates enforcement (in progress)  
⏳ Integration test coverage complete

## Non-Goals

- Unrelated feature work
- Mainnet deployment (Wave-10 scope)
- Stellar Wave activation (awaits maintainer)
- Runtime ABI switching (explicitly prohibited)
