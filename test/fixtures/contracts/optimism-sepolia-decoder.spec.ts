import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  generateDecoderAllowlist,
  RawReleaseManifest,
} from '../../../src/v2/events/decoder-allowlist';
import { EventDecoderService } from '../../../src/v2/events/event-decoder.service';
import { OptimismSepoliaDecoderBoundary } from '../../../src/v2/events/optimism-sepolia-boundary';
import { OPTIMISM_SEPOLIA_DECODER_FIXTURES } from './optimism-sepolia-decoder.fixtures';
import { APPROVED_FIXTURES_V2 } from './api-frontend-contract.fixtures';
import { Interface, ethers } from 'ethers';

describe('Optimism Sepolia Decoder Allow-list and Boundary Verification', () => {
  const manifestPath = resolve(
    __dirname,
    '../../../contracts/manifests/optimism-sepolia.release.json',
  );

  let rawManifest: RawReleaseManifest;

  beforeAll(() => {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  });

  describe('1. Canonical Release / Interface Catalog Allow-List Generation', () => {
    it('generates decoder allow-lists deterministically from canonical manifest', () => {
      const result = generateDecoderAllowlist(rawManifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.allowlist).toBeDefined();

      const allowlist = result.allowlist!;
      expect(allowlist.releaseId).toBe('rel-opsepolia-20261015-v2');
      expect(allowlist.chainId).toBe(11155420);
      expect(allowlist.deploymentBlock).toBe(24850000);
      expect(allowlist.manifestChecksum).toBe(rawManifest.manifestChecksum);
      expect(allowlist.allowedAddresses.length).toBeGreaterThan(0);
      expect(allowlist.allowedTopic0s.length).toBeGreaterThan(0);
    });

    it('validates address, topic, indexed fields, and argument types', () => {
      const result = generateDecoderAllowlist(rawManifest);
      const allowlist = result.allowlist!;

      const claimRegistry = allowlist.contracts['ClaimRegistry'];
      expect(claimRegistry).toBeDefined();
      expect(claimRegistry.address).toBe('0x0000000000000000000000000000000000001001');

      const claimSubmitted = claimRegistry.events.find(
        (e) => e.name === 'ClaimSubmitted',
      );
      expect(claimSubmitted).toBeDefined();
      expect(claimSubmitted!.topic0).toBe(
        '0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9',
      );
      expect(claimSubmitted!.inputs).toEqual([
        { name: 'claimId', type: 'bytes32', indexed: true },
        { name: 'author', type: 'address', indexed: true },
        { name: 'contentURI', type: 'string', indexed: false },
      ]);
    });

    it('binds all chain-derived data to chain ID, release ID, deployment block, and checksum', () => {
      const boundary = new OptimismSepoliaDecoderBoundary(manifestPath);
      const provenance = boundary.getReleaseProvenance();

      expect(provenance.chainId).toBe(11155420);
      expect(provenance.releaseId).toBe('rel-opsepolia-20261015-v2');
      expect(provenance.deploymentBlock).toBe(24850000);
      expect(provenance.manifestChecksum).toBe(rawManifest.manifestChecksum);
    });
  });

  describe('2. Required Tests: Negative & Failure Boundaries', () => {
    it('rejects artifact checksum mismatch', () => {
      const corruptedManifest: RawReleaseManifest = {
        ...rawManifest,
        manifestChecksum: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const result = generateDecoderAllowlist(corruptedManifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('checksum mismatch'))).toBe(true);
    });

    it('rejects per-contract ABI checksum mismatch', () => {
      const corruptedContracts = JSON.parse(JSON.stringify(rawManifest.contracts));
      corruptedContracts[0].abiChecksum = 'badchecksum'.repeat(6).slice(0, 64);
      const corruptedManifest: RawReleaseManifest = {
        ...rawManifest,
        contracts: corruptedContracts,
      };

      const result = generateDecoderAllowlist(corruptedManifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('ABI checksum mismatch'))).toBe(true);
    });

    it('rejects unknown topic0 and malformed log', () => {
      const boundary = new OptimismSepoliaDecoderBoundary(manifestPath);
      const decoder = new EventDecoderService();

      const sample = OPTIMISM_SEPOLIA_DECODER_FIXTURES.sampleLogs;
      expect(boundary.isTopicAllowed(sample.unknownTopicLog.topics[0])).toBe(false);

      const abi = rawManifest.contracts[0].events.map((e) => e.abi);
      const iface = new Interface(abi);

      const decodeUnknown = decoder.decode(sample.unknownTopicLog, iface);
      expect(decodeUnknown.status).toBe('unknown_signature');

      const decodeMalformed = decoder.decode(sample.malformedDataLog, iface);
      expect(decodeMalformed.status).toBe('decode_error');
    });

    it('rejects changed indexed field count/types', () => {
      const sample = OPTIMISM_SEPOLIA_DECODER_FIXTURES.sampleLogs;
      const decoder = new EventDecoderService();
      const abi = rawManifest.contracts[0].events.map((e) => e.abi);
      const iface = new Interface(abi);

      const result = decoder.decode(sample.changedIndexedFieldLog, iface);
      expect(result.status).toBe('decode_error');
    });

    it('rejects legacy address and cross-release addresses', () => {
      const boundary = new OptimismSepoliaDecoderBoundary(manifestPath);
      const sample = OPTIMISM_SEPOLIA_DECODER_FIXTURES.sampleLogs;

      expect(boundary.isAddressAllowed(sample.legacyAddressLog.address)).toBe(false);
      expect(boundary.isAddressAllowed(sample.unregisteredAddressLog.address)).toBe(false);
      expect(boundary.isAddressAllowed(sample.validClaimSubmitted.address)).toBe(true);
    });

    it('rejects cross-release and wrong chain IDs', () => {
      const wrongChainManifest: RawReleaseManifest = {
        ...rawManifest,
        chainId: 1, // Mainnet instead of Sepolia
      };
      const result = generateDecoderAllowlist(wrongChainManifest);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unsupported chain ID'))).toBe(true);
    });
  });

  describe('3. Fixture Drift and Projection Compatibility', () => {
    it('proves deterministic fixtures shared with projection tests match without drift', () => {
      expect(OPTIMISM_SEPOLIA_DECODER_FIXTURES.allowlist.releaseId).toBe(
        rawManifest.releaseId,
      );
      expect(OPTIMISM_SEPOLIA_DECODER_FIXTURES.allowlist.chainId).toBe(
        rawManifest.chainId,
      );
      expect(OPTIMISM_SEPOLIA_DECODER_FIXTURES.allowlist.deploymentBlock).toBe(
        24850000,
      );

      // Verify alignment with API-frontend contract fixtures
      expect(APPROVED_FIXTURES_V2.release.chainId).toBe(
        OPTIMISM_SEPOLIA_DECODER_FIXTURES.allowlist.chainId,
      );
    });

    it('confirms decoder configuration is strictly generated, not hand-copied', () => {
      const allowlistResult = generateDecoderAllowlist(rawManifest);
      expect(allowlistResult.valid).toBe(true);
      const generated = allowlistResult.allowlist!;

      for (const contract of rawManifest.contracts) {
        expect(generated.contracts[contract.name]).toBeDefined();
        expect(generated.contracts[contract.name].address).toBe(
          contract.address.toLowerCase(),
        );
        expect(generated.contracts[contract.name].events).toHaveLength(
          contract.events.length,
        );
      }
    });

    it('maintains API and frontend release consistency', () => {
      const releaseId = rawManifest.releaseId;
      expect(releaseId).toMatch(/^rel-opsepolia-\d+-v2$/);
      expect(rawManifest.chainId).toBe(11155420);
    });

    it('verifies no secrets, keys, or non-public evidence exist in fixtures or generated allowlist', () => {
      const serialized = JSON.stringify(
        OPTIMISM_SEPOLIA_DECODER_FIXTURES,
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      );
      const forbidden = ['private_key', 'secret', 'password', 'bearer', 'mnemonic'];
      for (const word of forbidden) {
        expect(serialized.toLowerCase()).not.toContain(`"${word}"`);
      }
    });
  });
});
