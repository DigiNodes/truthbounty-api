import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ethers } from 'ethers';
import {
  ContractManifestValidatorService,
} from './contract-manifest-validator.service';
import {
  ContractAddressManifest,
  ManifestContractEntry,
} from './contract-manifest.interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_EVENT_ABI = 'event Staked(address indexed user, uint256 amount)';

/**
 * Computes the canonical topic0 (keccak256 of the event sighash) from an ABI
 * string so tests can build manifests with correct topic0 values.
 */
function topic0FromAbi(abi: string): string {
  const fragment = ethers.EventFragment.from(abi);
  return ethers.id(fragment.format('sighash'));
}

/** Produces a checksummed address that passes ethers.getAddress validation. */
function checksummedAddr(suffix = '0001'): string {
  const padded = `0x${'0'.repeat(40 - suffix.length)}${suffix}`;
  return ethers.getAddress(padded);
}

function buildEvents(
  overrides: Partial<ManifestContractEntry['events'][number]>[] = [],
) {
  const base = [{ name: 'Staked', abi: VALID_EVENT_ABI }];
  return overrides.length
    ? overrides.map((o, i) => ({ ...base[0], ...o, name: o.name ?? `Evt${i}` }))
    : base;
}

function abiChecksum(events: ManifestContractEntry['events']): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

function manifestChecksum(contracts: ManifestContractEntry[]): string {
  return createHash('sha256').update(JSON.stringify(contracts)).digest('hex');
}

function buildContract(
  overrides: Partial<ManifestContractEntry> = {},
): ManifestContractEntry {
  const events = overrides.events ?? buildEvents();
  const base: ManifestContractEntry = {
    name: 'StakeContract',
    address: checksummedAddr('0001'),
    deployBlock: 1_000_000,
    abiChecksum: abiChecksum(events),
    events,
  };
  return { ...base, ...overrides, events };
}

function buildManifest(
  overrides: Partial<ContractAddressManifest> = {},
  contractOverrides: Partial<ManifestContractEntry>[] = [],
): ContractAddressManifest {
  const contracts = contractOverrides.length
    ? contractOverrides.map((o) => buildContract(o))
    : [buildContract()];
  const base: ContractAddressManifest = {
    version: '1.0.0',
    chainId: 10,
    publishedAt: new Date().toISOString(),
    manifestChecksum: manifestChecksum(contracts),
    contracts,
  };
  return { ...base, ...overrides, contracts: overrides.contracts ?? contracts };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('ContractManifestValidatorService', () => {
  let service: ContractManifestValidatorService;
  let configGet: jest.Mock;

  const makeService = async (
    configValues: Record<string, unknown> = {},
  ): Promise<ContractManifestValidatorService> => {
    configGet = jest.fn((key: string, def?: unknown) => {
      const defaults: Record<string, unknown> = {
        MANIFEST_VALIDATION: undefined,           // not disabled
        BLOCKCHAIN_STARTUP_RPC_CHECK: 'false',    // no live network in tests
        OPTIMISM_RPC_URL: 'https://mainnet.optimism.io',
        CONTRACT_ADDRESS_MANIFEST: undefined,
        MANIFEST_MAX_AGE_DAYS: undefined,         // use default (90)
        ...configValues,
      };
      return key in defaults ? defaults[key] : def;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractManifestValidatorService,
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    return module.get(ContractManifestValidatorService);
  };

  beforeEach(async () => {
    service = await makeService();
  });

  // ── onApplicationBootstrap lifecycle ─────────────────────────────────────

  describe('onApplicationBootstrap', () => {
    it('skips validation when MANIFEST_VALIDATION=false', async () => {
      const svc = await makeService({ MANIFEST_VALIDATION: 'false' });
      await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('skips when CONTRACT_ADDRESS_MANIFEST is not set', async () => {
      const svc = await makeService({ CONTRACT_ADDRESS_MANIFEST: undefined });
      await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    });

    it('throws when CONTRACT_ADDRESS_MANIFEST is not valid JSON', async () => {
      const svc = await makeService({
        CONTRACT_ADDRESS_MANIFEST: 'not-json{{{',
      });
      await expect(svc.onApplicationBootstrap()).rejects.toThrow(
        /not valid JSON/i,
      );
    });

    it('throws (fail-closed) when the manifest is invalid', async () => {
      const badManifest: ContractAddressManifest = {
        ...buildManifest(),
        chainId: 999 as any, // unsupported chain
      };
      const svc = await makeService({
        CONTRACT_ADDRESS_MANIFEST: JSON.stringify(badManifest),
      });
      await expect(svc.onApplicationBootstrap()).rejects.toThrow(
        /validation failed/i,
      );
    });

    it('resolves without error for a fully valid manifest', async () => {
      const svc = await makeService({
        CONTRACT_ADDRESS_MANIFEST: JSON.stringify(buildManifest()),
      });
      await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  // ── validateManifest — schema checks ─────────────────────────────────────

  describe('validateManifest — schema checks', () => {
    it('returns invalid for a null input', async () => {
      const report = await service.validateManifest(null as any);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/non-null object/i);
    });

    it('flags a missing version field', async () => {
      const m = buildManifest();
      delete (m as any).version;
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/version/i);
    });

    it('flags a missing publishedAt field', async () => {
      const m = buildManifest();
      delete (m as any).publishedAt;
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/publishedAt/i);
    });

    it('flags a missing manifestChecksum field', async () => {
      const m = buildManifest();
      delete (m as any).manifestChecksum;
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/manifestChecksum/i);
    });

    it('flags when contracts is not an array', async () => {
      const m = { ...buildManifest(), contracts: 'bad' } as any;
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/contracts/i);
    });
  });

  // ── validateManifest — chain guard ────────────────────────────────────────

  describe('validateManifest — chain guard', () => {
    it.each([10, 11155420])(
      'accepts Optimism chain ID %i',
      async (chainId) => {
        const contracts = [buildContract()];
        const m: ContractAddressManifest = {
          version: '1.0.0',
          chainId: chainId as any,
          publishedAt: new Date().toISOString(),
          manifestChecksum: manifestChecksum(contracts),
          contracts,
        };
        const report = await service.validateManifest(m);
        expect(report.valid).toBe(true);
      },
    );

    it.each([1, 137, 42161, 56, 0, -1, 999])(
      'rejects non-Optimism chain ID %i',
      async (chainId) => {
        const contracts = [buildContract()];
        const m: ContractAddressManifest = {
          version: '1.0.0',
          chainId: chainId as any,
          publishedAt: new Date().toISOString(),
          manifestChecksum: manifestChecksum(contracts),
          contracts,
        };
        const report = await service.validateManifest(m);
        expect(report.valid).toBe(false);
        expect(report.errors.join(' ')).toMatch(/allowed Optimism chain/i);
      },
    );
  });

  // ── validateManifest — freshness checks ───────────────────────────────────

  describe('validateManifest — freshness check', () => {
    it('accepts a manifest published today', async () => {
      const report = await service.validateManifest(buildManifest());
      expect(report.valid).toBe(true);
      expect(report.manifestAgedays).toBeGreaterThanOrEqual(0);
      expect(report.manifestAgedays).toBeLessThanOrEqual(1);
    });

    it('accepts a manifest published 30 days ago (within default 90-day window)', async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const m = buildManifest({ publishedAt: thirtyDaysAgo.toISOString() });
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(true);
      expect(report.manifestAgedays).toBeGreaterThanOrEqual(29);
    });

    it('rejects a manifest published 91 days ago (exceeds default 90-day limit)', async () => {
      const ninetyOneDaysAgo = new Date(
        Date.now() - 91 * 24 * 60 * 60 * 1000,
      );
      const m = buildManifest({ publishedAt: ninetyOneDaysAgo.toISOString() });
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/stale/i);
    });

    it('rejects a manifest with a publishedAt date in the future', async () => {
      const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const m = buildManifest({ publishedAt: tomorrow.toISOString() });
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/in the future/i);
    });

    it('rejects a manifest with an unparseable publishedAt string', async () => {
      const m = buildManifest({ publishedAt: 'not-a-date' });
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/not a valid ISO-8601/i);
    });

    it('respects a custom MANIFEST_MAX_AGE_DAYS override', async () => {
      // Only 5 days allowed.
      const svc = await makeService({ MANIFEST_MAX_AGE_DAYS: '5' });
      const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      const m = buildManifest({ publishedAt: sixDaysAgo.toISOString() });
      const report = await svc.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/stale/i);
    });

    it('exposes manifestAgedays on the report even when validation passes', async () => {
      const oneDayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const m = buildManifest({ publishedAt: oneDayAgo.toISOString() });
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(true);
      expect(report.manifestAgedays).toBe(1);
    });
  });

  // ── validateManifest — manifest integrity ─────────────────────────────────

  describe('validateManifest — manifest integrity checksum', () => {
    it('passes when manifestChecksum matches computed value', async () => {
      const report = await service.validateManifest(buildManifest());
      expect(report.valid).toBe(true);
    });

    it('fails when manifestChecksum is tampered', async () => {
      const m = buildManifest();
      m.manifestChecksum = 'deadbeef'.repeat(8);
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.join(' ')).toMatch(/integrity check failed/i);
    });
  });

  // ── validateContractEntry — address validation ───────────────────────────

  describe('validateContractEntry — address validation', () => {
    it('passes for a valid checksummed address', () => {
      const result = service.validateContractEntry(buildContract());
      expect(result.valid).toBe(true);
    });

    it('fails for a missing address', () => {
      const result = service.validateContractEntry(
        buildContract({ address: '' }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/missing address/i);
    });

    it('fails for an address that is too short', () => {
      const result = service.validateContractEntry(
        buildContract({ address: '0x1234' }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/not a valid 20-byte hex/i);
    });

    it('fails for an address with non-hex characters', () => {
      const result = service.validateContractEntry(
        buildContract({ address: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG' }),
      );
      expect(result.valid).toBe(false);
    });

    it('fails for the zero address', () => {
      const result = service.validateContractEntry(
        buildContract({
          address: '0x0000000000000000000000000000000000000000',
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/zero address/i);
    });

    it('fails for a non-checksummed (lowercase) address', () => {
      const checksummed = checksummedAddr('abcd');
      const lower = checksummed.toLowerCase();
      const result = service.validateContractEntry(
        buildContract({ address: lower }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/EIP-55 checksummed/i);
    });
  });

  // ── validateContractEntry — deployBlock ──────────────────────────────────

  describe('validateContractEntry — deployBlock', () => {
    it('passes for a valid non-negative integer deployBlock', () => {
      const result = service.validateContractEntry(
        buildContract({ deployBlock: 0 }),
      );
      expect(result.valid).toBe(true);
    });

    it('fails for a negative deployBlock', () => {
      const result = service.validateContractEntry(
        buildContract({ deployBlock: -1 }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/non-negative integer/i);
    });

    it('fails for a float deployBlock', () => {
      const result = service.validateContractEntry(
        buildContract({ deployBlock: 1.5 }),
      );
      expect(result.valid).toBe(false);
    });

    it('fails for a string deployBlock', () => {
      const result = service.validateContractEntry(
        buildContract({ deployBlock: '1000000' as any }),
      );
      expect(result.valid).toBe(false);
    });
  });

  // ── validateContractEntry — events ───────────────────────────────────────

  describe('validateContractEntry — events', () => {
    it('fails when events array is empty', () => {
      const result = service.validateContractEntry(
        buildContract({ events: [] }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/at least one event/i);
    });

    it('fails when an event has no ABI string', () => {
      const events = [{ name: 'NoAbi', abi: '' }];
      const result = service.validateContractEntry(
        buildContract({ events: events as any, abiChecksum: abiChecksum(events as any) }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/no ABI string/i);
    });

    it('fails when the ABI parses as a function, not an event', () => {
      const events = [{ name: 'NotAnEvent', abi: 'function foo()' }];
      const result = service.validateContractEntry(
        buildContract({
          events: events as any,
          abiChecksum: abiChecksum(events as any),
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/expected "event"/i);
    });

    it('fails for a completely malformed ABI string', () => {
      const events = [{ name: 'Bad', abi: 'not-valid-abi-string' }];
      const result = service.validateContractEntry(
        buildContract({
          events: events as any,
          abiChecksum: abiChecksum(events as any),
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/ABI is invalid/i);
    });
  });

  // ── validateContractEntry — topic0 cross-check ───────────────────────────

  describe('validateContractEntry — topic0 cross-check', () => {
    it('passes when topic0 matches the ABI-derived hash', () => {
      const correctTopic0 = topic0FromAbi(VALID_EVENT_ABI);
      const events = [{ name: 'Staked', abi: VALID_EVENT_ABI, topic0: correctTopic0 }];
      const result = service.validateContractEntry(
        buildContract({ events, abiChecksum: abiChecksum(events) }),
      );
      expect(result.valid).toBe(true);
    });

    it('fails when the declared topic0 does not match the ABI-derived hash', () => {
      const wrongTopic0 = '0x' + 'aa'.repeat(32);
      const events = [{ name: 'Staked', abi: VALID_EVENT_ABI, topic0: wrongTopic0 }];
      const result = service.validateContractEntry(
        buildContract({ events, abiChecksum: abiChecksum(events) }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/topic0 mismatch/i);
    });

    it('skips topic0 check when topic0 is omitted', () => {
      // No topic0 field — should still be valid.
      const events = [{ name: 'Staked', abi: VALID_EVENT_ABI }];
      const result = service.validateContractEntry(
        buildContract({ events, abiChecksum: abiChecksum(events) }),
      );
      expect(result.valid).toBe(true);
    });

    it('correctly validates topic0 for a multi-param indexed event', () => {
      const abi =
        'event Transfer(address indexed from, address indexed to, uint256 amount)';
      const correctTopic0 = topic0FromAbi(abi);
      const events = [{ name: 'Transfer', abi, topic0: correctTopic0 }];
      const result = service.validateContractEntry(
        buildContract({ events, abiChecksum: abiChecksum(events) }),
      );
      expect(result.valid).toBe(true);
    });
  });

  // ── validateContractEntry — ABI checksum ─────────────────────────────────

  describe('validateContractEntry — ABI checksum', () => {
    it('passes when abiChecksum matches', () => {
      const events = buildEvents();
      const result = service.validateContractEntry(
        buildContract({ events, abiChecksum: abiChecksum(events) }),
      );
      expect(result.valid).toBe(true);
    });

    it('fails when abiChecksum is tampered', () => {
      const result = service.validateContractEntry(
        buildContract({ abiChecksum: 'deadbeef'.repeat(8) }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/ABI checksum mismatch/i);
    });
  });

  // ── Multiple contracts in a manifest ─────────────────────────────────────

  describe('validateManifest — multiple contracts', () => {
    it('reports per-contract results for a manifest with two valid contracts', async () => {
      const contracts = [
        buildContract({ name: 'ContractA', address: checksummedAddr('0001') }),
        buildContract({ name: 'ContractB', address: checksummedAddr('0002') }),
      ];
      const m: ContractAddressManifest = {
        version: '2.0.0',
        chainId: 10,
        publishedAt: new Date().toISOString(),
        manifestChecksum: manifestChecksum(contracts),
        contracts,
      };
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(true);
      expect(report.contractCount).toBe(2);
      expect(report.contractResults).toHaveLength(2);
      expect(report.contractResults.every((r) => r.valid)).toBe(true);
    });

    it('collects errors from all invalid contracts', async () => {
      const badContracts = [
        buildContract({ address: '0xinvalid' }),
        buildContract({ events: [] }),
      ];
      const m: ContractAddressManifest = {
        version: '1.0.0',
        chainId: 10,
        publishedAt: new Date().toISOString(),
        manifestChecksum: manifestChecksum(badContracts),
        contracts: badContracts,
      };
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(1);
    });
  });

  // ── Utility helpers ───────────────────────────────────────────────────────

  describe('computeManifestChecksum / computeAbiChecksum', () => {
    it('computeManifestChecksum matches what the manifest builder produces', () => {
      const contracts = [buildContract()];
      const expected = manifestChecksum(contracts);
      expect(service.computeManifestChecksum(contracts)).toBe(expected);
    });

    it('computeAbiChecksum matches what the contract builder produces', () => {
      const events = buildEvents();
      const expected = abiChecksum(events);
      expect(service.computeAbiChecksum(events)).toBe(expected);
    });

    it('computeManifestChecksum is deterministic for the same input', () => {
      const contracts = [buildContract()];
      expect(service.computeManifestChecksum(contracts)).toBe(
        service.computeManifestChecksum(contracts),
      );
    });

    it('computeManifestChecksum differs when contracts differ', () => {
      const c1 = [buildContract({ name: 'A' })];
      const c2 = [buildContract({ name: 'B' })];
      expect(service.computeManifestChecksum(c1)).not.toBe(
        service.computeManifestChecksum(c2),
      );
    });
  });

  // ── Boundary / edge cases ─────────────────────────────────────────────────

  describe('boundary and edge cases', () => {
    it('handles an empty contracts array (valid structure, but practically useless)', async () => {
      const contracts: ManifestContractEntry[] = [];
      const m: ContractAddressManifest = {
        version: '1.0.0',
        chainId: 10,
        publishedAt: new Date().toISOString(),
        manifestChecksum: manifestChecksum(contracts),
        contracts,
      };
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(true);
      expect(report.contractCount).toBe(0);
    });

    it('handles a manifest with the Sepolia chain ID (11155420)', async () => {
      const contracts = [buildContract()];
      const m: ContractAddressManifest = {
        version: '1.0.0',
        chainId: 11155420,
        publishedAt: new Date().toISOString(),
        manifestChecksum: manifestChecksum(contracts),
        contracts,
      };
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(true);
      expect(report.chainId).toBe(11155420);
    });

    it('rejects a manifest where contracts is null', async () => {
      const m = { ...buildManifest(), contracts: null } as any;
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
    });

    it('captures multiple errors per contract without short-circuiting', () => {
      const result = service.validateContractEntry(
        buildContract({
          address: '',
          deployBlock: -5,
          events: [],
        }),
      );
      expect(result.valid).toBe(false);
      // Should have errors for address + deployBlock + events.
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Regression: no silent fallback to fabricated state ────────────────────

  describe('regression: fail-closed invariants', () => {
    it('never returns valid=true when any error has been recorded', async () => {
      const m = buildManifest();
      m.manifestChecksum = 'tampered';
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it('never silently ignores an unsupported chain', async () => {
      const contracts = [buildContract()];
      const m: ContractAddressManifest = {
        version: '1.0.0',
        chainId: 1 as any, // Ethereum mainnet — not Optimism
        publishedAt: new Date().toISOString(),
        manifestChecksum: manifestChecksum(contracts),
        contracts,
      };
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => e.includes('1'))).toBe(true);
    });

    it('produces a separate contractResult entry per contract regardless of pass/fail', async () => {
      const c1 = buildContract({ name: 'Good', address: checksummedAddr('0001') });
      const c2 = buildContract({ name: 'BadAddr', address: '' });
      const contracts = [c1, c2];
      const m: ContractAddressManifest = {
        version: '1.0.0',
        chainId: 10,
        publishedAt: new Date().toISOString(),
        manifestChecksum: manifestChecksum(contracts),
        contracts,
      };
      const report = await service.validateManifest(m);
      expect(report.contractResults).toHaveLength(2);
      const good = report.contractResults.find((r) => r.name === 'Good');
      const bad = report.contractResults.find((r) => r.name === 'BadAddr');
      expect(good?.valid).toBe(true);
      expect(bad?.valid).toBe(false);
    });

    it('stale manifest does not receive a valid=true report', async () => {
      // 200 days old — far beyond the default 90-day limit.
      const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
      const m = buildManifest({ publishedAt: veryOld.toISOString() });
      const report = await service.validateManifest(m);
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => /stale/i.test(e))).toBe(true);
    });

    it('wrong topic0 does not silently pass when other fields are valid', () => {
      const wrongTopic0 = '0x' + 'cc'.repeat(32);
      const events = [{ name: 'Staked', abi: VALID_EVENT_ABI, topic0: wrongTopic0 }];
      const result = service.validateContractEntry(
        buildContract({ events, abiChecksum: abiChecksum(events) }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /topic0 mismatch/i.test(e))).toBe(true);
    });
  });
});
