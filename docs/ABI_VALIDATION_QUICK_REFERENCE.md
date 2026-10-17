# ABI Validation Quick Reference

Quick guide for working with the enhanced ABI validation system.

## Common Tasks

### Generate Manifest Event Entry

```typescript
import { ethers } from 'ethers';
import { AbiValidationService } from './src/contracts/abi-validation.service';

const abi = 'event Transfer(address indexed from, address indexed to, uint256 amount)';
const fragment = ethers.EventFragment.from(abi);
const abiValidation = new AbiValidationService();

const eventEntry = {
  name: fragment.name,
  abi: abi,
  topic0: fragment.anonymous ? null : ethers.id(fragment.format('sighash')),
  signature: fragment.format('sighash'),
  anonymous: fragment.anonymous,
  indexed: abiValidation.extractIndexedParameters(abi),
};
```

### Validate Manifest Before Commit

```bash
# Run full validation
npm run validate:manifests

# Check specific manifest file
node scripts/validate-manifest.js contracts/manifests/optimism-sepolia.release.json
```

### Debug Overload Issues

```typescript
// Check if event has overloads
const overloads = abiValidation.detectEventOverloads(contractAbi);
if (overloads.hasOverloads) {
  console.log('Overloaded events:', overloads.overloads);
  
  // Ensure each has unique topic0
  for (const overload of overloads.overloads) {
    overload.signatures.forEach(sig => {
      const topic = ethers.id(sig);
      console.log(`${sig} => ${topic}`);
    });
  }
}
```

### Check for Collisions

```typescript
const collisions = abiValidation.detectCollisions(contractAbi);

if (collisions.topicCollisions.length > 0) {
  console.error('Topic0 collisions detected:', collisions.topicCollisions);
}

if (collisions.selectorCollisions.length > 0) {
  console.error('Selector collisions detected:', collisions.selectorCollisions);
}
```

### Validate Indexed Field Changes

```typescript
const oldAbi = 'event Transfer(address indexed from, address indexed to, uint256 amount)';
const newAbi = 'event Transfer(uint256 indexed from, address indexed to, uint256 amount)';

const result = abiValidation.validateIndexedFieldLayout(oldAbi, newAbi);

if (!result.valid) {
  console.error('Incompatible indexed field changes:', result.errors);
}
```

## Error Messages

### "Version mismatch: decoder claims X but manifest specifies Y"

**Cause:** Decoder version doesn't match pinned manifest version  
**Fix:** Update decoder version or use correct manifest

```typescript
// In your decoder config
const DECODER_VERSION = '2.0.0-rc.3'; // Must match manifest.version
```

### "Topic0 collision detected for 0x..."

**Cause:** Different events producing same topic0 (extremely rare, cryptographic collision)  
**Fix:** Rename one of the events or investigate ABI generation

### "Duplicate event signature: X appears N times"

**Cause:** Same event defined multiple times in manifest  
**Fix:** Remove duplicate entry from manifest

### "Event 'X' topic0 mismatch: declared Y but ABI derives Z"

**Cause:** topic0 field doesn't match computed value  
**Fix:** Regenerate manifest with correct topic0

```typescript
const correctTopic0 = ethers.id(fragment.format('sighash'));
```

### "Indexed parameter count changed: X -> Y"

**Cause:** Number of indexed parameters changed between versions  
**Fix:** This is a breaking change; requires migration

## Testing Scenarios

### Test Overloaded Event Decoding

```typescript
describe('Overload Test', () => {
  it('decodes both Transfer variants', () => {
    const iface = new Interface([
      'event Transfer(address indexed from, address indexed to, uint256 amount)',
      'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)',
    ]);

    // Both should decode correctly with different signatures
    const resultV1 = decoder.decode(logV1, iface);
    expect(resultV1.signature).toBe('Transfer(address,address,uint256)');

    const resultV2 = decoder.decode(logV2, iface);
    expect(resultV2.signature).toBe('Transfer(address,address,uint256,bytes)');
  });
});
```

### Test Anonymous Event

```typescript
it('handles anonymous events', () => {
  const anonAbi = 'event InternalLog(bytes data) anonymous';
  const fragment = ethers.EventFragment.from(anonAbi);
  
  expect(fragment.anonymous).toBe(true);
  
  // Anonymous events have no topic0
  const topic0 = abiValidation.computeTopic0(anonAbi);
  expect(topic0).toBeNull();
});
```

### Test Version Pinning

```typescript
it('rejects stale decoder version', () => {
  const result = versionCompatibility.validateDecoderCompatibility(
    '2.0.0',      // manifest version
    'rel-v2',     // release ID
    '1.9.0'       // decoder version (stale)
  );
  
  expect(result.compatible).toBe(false);
  expect(result.errors).toContain('Version mismatch');
});
```

## Environment Variables

```bash
# Disable manifest validation (not recommended)
MANIFEST_VALIDATION=false

# Set max manifest age (days)
MANIFEST_MAX_AGE_DAYS=90

# Disable on-chain code check (dev only)
BLOCKCHAIN_STARTUP_RPC_CHECK=false

# Production environment flag
NODE_ENV=production
```

## CLI Commands

```bash
# Validate all manifests
npm run validate:manifests

# Run ABI validation tests
npm test -- --testPathPattern=abi-validation

# Run event overload tests
npm test -- --testPathPattern=event-overload

# Check for collisions in contract ABI
node scripts/check-collisions.js path/to/contract.json

# Generate manifest from contract artifacts
node scripts/generate-manifest.js --network optimism-sepolia
```

## Troubleshooting

### Validation Fails at Startup

1. Check manifest version matches decoder version
2. Verify all required fields present (topic0, signature, anonymous, indexed)
3. Run validation locally: `npm run validate:manifests`
4. Check logs for specific error

### Events Not Decoding

1. Verify topic0 in logs matches manifest topic0
2. Check if event is overloaded (need full signature)
3. Confirm artifact version matches manifest version
4. Check quarantine table for failed decodes

### CI Failing on Validation

1. Manifest may be stale (>90 days old)
2. Missing required fields
3. Collision or duplicate detected
4. Check CI logs for specific validation error

## Best Practices

1. **Always regenerate manifests** - Don't hand-edit topic0 or signatures
2. **Test overloads explicitly** - If adding overloaded events, add tests
3. **Version lock** - Pin manifest version in deployment configs
4. **Review warnings** - Anonymous events and overloads need review
5. **Validate locally first** - Run validation before pushing

## See Also

- [ABI_VALIDATION_PRODUCTION_READINESS.md](./ABI_VALIDATION_PRODUCTION_READINESS.md) - Full documentation
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment procedures
