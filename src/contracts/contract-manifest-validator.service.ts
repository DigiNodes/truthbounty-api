import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ethers } from 'ethers';
import {
  ALLOWED_CHAIN_IDS,
  DEFAULT_MANIFEST_MAX_AGE_DAYS,
  ContractAddressManifest,
  ManifestContractEntry,
  ManifestContractValidationResult,
  ManifestValidationReport,
} from './contract-manifest.interface';
import { ManifestReadinessService } from './manifest-readiness.service';

/**
 * ContractManifestValidatorService
 *
 * Validates the canonical contract address manifest before the indexer ingests
 * any blocks. Satisfies V2 task: "Validate the Contract Address Manifest".
 *
 * Validation pipeline
 * -------------------
 * 1. Schema: required fields (version, releaseId, chainId, publishedAt,
 *    manifestChecksum, deploymentFloor, contracts) must be present and
 *    well-typed.
 * 2. Chain guard: chainId must be an Optimism value (10 or 11155420).
 *    Any other chain is rejected — no Stellar, Soroana, or alternate-chain
 *    runtime paths are allowed.
 * 3. Freshness check: publishedAt must parse as a valid ISO-8601 date and must
 *    not exceed MANIFEST_MAX_AGE_DAYS (default 90) days ago. Stale manifests
 *    are rejected; operators must rotate them on schedule.
 * 4. Manifest integrity: SHA-256 of JSON.stringify(contracts) must match
 *    the declared `manifestChecksum`.
 * 5. Empty-manifest rejection: a manifest with zero contracts is rejected.
 * 6. Duplicate address detection: no two contracts may share the same address.
 * 7. Release guard: all contract entries must carry the same releaseId as the
 *    manifest-level releaseId (mixed-release manifests are rejected). Per-entry
 *    releaseId is optional; if omitted the manifest-level value is assumed.
 * 8. Per-contract pure checks (no I/O):
 *    a. Address shape — /^0x[a-fA-F0-9]{40}$/
 *    b. EIP-55 checksum via ethers.getAddress()
 *    c. Zero/dummy address rejection
 *    d. deployBlock must be a non-negative integer
 *    e. deployBlock >= manifest-level deploymentFloor (deployment-floor check)
 *    f. At least one event fragment
 *    g. Each event ABI must parse as an `event` fragment via ethers
 *    h. Optional topic0 cross-check: when present, the supplied topic0 hash
 *       must match ethers.id(canonical_event_signature).
 *    i. Per-contract abiChecksum (SHA-256 of JSON.stringify(events)) must match
 *    j. Proxy provenance all-or-nothing: if any of (proxyAdmin,
 *       implementationAddress, implementationCodeHash) is present, all three
 *       must be present and non-empty, and both addresses must be valid.
 * 9. Optional on-chain code check (disabled with BLOCKCHAIN_STARTUP_RPC_CHECK=false):
 *    - Validates RPC chain ID against manifest chainId
 *    - Calls eth_getCode for each address; no deployed bytecode → fail closed
 *      (EOA rejection)
 *    - If proxy provenance present: fetches implementation bytecode and
 *      verifies keccak256 matches implementationCodeHash (code-hash mismatch
 *      or stale proxy detection)
 *
 * Failure mode
 * ------------
 * Any validation failure causes `onApplicationBootstrap` to throw, preventing
 * the application from starting with an invalid manifest. The service never
 * falls back to a fabricated or default address — fail closed.
 */
@Injectable()
export class ContractManifestValidatorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContractManifestValidatorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly manifestReadinessService: ManifestReadinessService,
  ) {}

  /**
   * Called by NestJS after all modules are initialised.
   * Throws on any validation error (fail-closed).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get<string>('MANIFEST_VALIDATION') === 'false') {
      this.logger.warn(
        'Contract manifest validation disabled via MANIFEST_VALIDATION=false',
      );
      return;
    }

    const raw = this.configService.get<string>('CONTRACT_ADDRESS_MANIFEST');
    if (!raw) {
      this.logger.warn(
        'CONTRACT_ADDRESS_MANIFEST not set — skipping manifest validation',
      );
      return;
    }

    let manifest: ContractAddressManifest;
    try {
      manifest = JSON.parse(raw) as ContractAddressManifest;
    } catch (err) {
      const msg = `CONTRACT_ADDRESS_MANIFEST is not valid JSON: ${String(err)}`;
      this.logger.error(msg);
      this.manifestReadinessService.markFailed(msg);
      throw new Error(msg);
    }

    const report = await this.validateManifest(manifest);

    if (!report.valid) {
      const summary = `${report.errors.length} validation error(s): ` +
        report.errors.slice(0, 5).join('; ') +
        (report.errors.length > 5 ? ' …' : '');
      this.manifestReadinessService.markFailed(summary);

      const msg =
        `Contract address manifest validation failed (${report.errors.length} error(s)):\n` +
        report.errors.map((e) => `  - ${e}`).join('\n');
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.manifestReadinessService.markReady(
      report.releaseId,
      report.version,
      report.chainId,
      report.contractCount,
    );

    this.logger.log(
      `Contract manifest v${report.version} validated — ` +
        `release ${report.releaseId}, ` +
        `chain ${report.chainId}, ${report.contractCount} contract(s) OK` +
        (report.manifestAgedays !== undefined
          ? `, age ${report.manifestAgedays}d`
          : ''),
    );
  }

  /**
   * Validate a parsed manifest object.
   * Returns a full report; does not throw — callers decide how to act.
   */
  async validateManifest(
    manifest: ContractAddressManifest,
  ): Promise<ManifestValidationReport> {
    const errors: string[] = [];

    // ── 1. Schema presence checks ──────────────────────────────────────────
    if (!manifest || typeof manifest !== 'object') {
      return {
        valid: false,
        version: 'unknown',
        releaseId: 'unknown',
        chainId: 0,
        contractCount: 0,
        contractResults: [],
        errors: ['manifest must be a non-null object'],
      };
    }

    if (!manifest.version || typeof manifest.version !== 'string') {
      errors.push('manifest.version is required and must be a string');
    }
    if (!manifest.releaseId || typeof manifest.releaseId !== 'string') {
      errors.push(
        'manifest.releaseId is required and must be a non-empty string',
      );
    }
    if (!manifest.publishedAt || typeof manifest.publishedAt !== 'string') {
      errors.push('manifest.publishedAt is required and must be a string');
    }
    if (
      !manifest.manifestChecksum ||
      typeof manifest.manifestChecksum !== 'string'
    ) {
      errors.push('manifest.manifestChecksum is required and must be a string');
    }
    if (
      typeof manifest.deploymentFloor !== 'number' ||
      !Number.isInteger(manifest.deploymentFloor) ||
      manifest.deploymentFloor < 0
    ) {
      errors.push(
        'manifest.deploymentFloor is required and must be a non-negative integer',
      );
    }
    if (!Array.isArray(manifest.contracts)) {
      errors.push('manifest.contracts must be an array');
    }

    // ── 2. Chain guard ─────────────────────────────────────────────────────
    const chainId = manifest.chainId;
    if (!ALLOWED_CHAIN_IDS.includes(chainId)) {
      errors.push(
        `chainId ${chainId} is not an allowed Optimism chain ID ` +
          `(allowed: ${ALLOWED_CHAIN_IDS.join(', ')})`,
      );
    }

    // Abort early if structural errors make further checks meaningless.
    if (!Array.isArray(manifest.contracts)) {
      return {
        valid: false,
        version: manifest.version ?? 'unknown',
        releaseId: manifest.releaseId ?? 'unknown',
        chainId: manifest.chainId ?? 0,
        contractCount: 0,
        contractResults: [],
        errors,
      };
    }

    // ── 3. Freshness check ────────────────────────────────────────────────
    let manifestAgeDays: number | undefined;
    if (manifest.publishedAt && typeof manifest.publishedAt === 'string') {
      const publishedMs = Date.parse(manifest.publishedAt);
      if (Number.isNaN(publishedMs)) {
        errors.push(
          `manifest.publishedAt "${manifest.publishedAt}" is not a valid ISO-8601 date`,
        );
      } else {
        const maxAgeDays =
          Number(this.configService.get<string>('MANIFEST_MAX_AGE_DAYS')) ||
          DEFAULT_MANIFEST_MAX_AGE_DAYS;
        manifestAgeDays = Math.floor(
          (Date.now() - publishedMs) / (1000 * 60 * 60 * 24),
        );
        if (manifestAgeDays > maxAgeDays) {
          errors.push(
            `manifest is stale: publishedAt is ${manifestAgeDays} days ago ` +
              `(max allowed ${maxAgeDays} days). Rotate the manifest.`,
          );
        }
        // Future-dated manifests are also invalid.
        if (publishedMs > Date.now()) {
          errors.push(
            `manifest.publishedAt "${manifest.publishedAt}" is in the future`,
          );
        }
      }
    }

    // ── 4. Manifest integrity checksum ────────────────────────────────────
    if (manifest.manifestChecksum) {
      const computed = createHash('sha256')
        .update(JSON.stringify(manifest.contracts))
        .digest('hex');
      if (computed !== manifest.manifestChecksum) {
        errors.push(
          `manifest integrity check failed: computed checksum ${computed} ` +
            `does not match declared ${manifest.manifestChecksum}`,
        );
      }
    }

    // ── 5. Empty manifest rejection ───────────────────────────────────────
    if (manifest.contracts.length === 0) {
      errors.push(
        'manifest must contain at least one contract; empty manifests are rejected',
      );
    }

    // ── 6. Duplicate address detection ────────────────────────────────────
    const seenAddresses = new Map<string, string>(); // normalised → name
    for (const contract of manifest.contracts) {
      if (contract.address && /^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
        const normalised = contract.address.toLowerCase();
        if (seenAddresses.has(normalised)) {
          errors.push(
            `duplicate address ${contract.address}: appears in both ` +
              `"${seenAddresses.get(normalised)}" and "${contract.name ?? '<unnamed>'}"`,
          );
        } else {
          seenAddresses.set(normalised, contract.name ?? '<unnamed>');
        }
      }
    }

    // ── 7. Mixed-release guard ────────────────────────────────────────────
    const manifestReleaseId = manifest.releaseId;
    if (manifestReleaseId && typeof manifestReleaseId === 'string') {
      for (const contract of manifest.contracts) {
        // If the per-entry releaseId is explicitly set and differs, reject.
        if (
          contract.releaseId !== undefined &&
          contract.releaseId !== manifestReleaseId
        ) {
          errors.push(
            `mixed-release manifest: contract "${contract.name ?? '<unnamed>'}" ` +
              `has releaseId "${contract.releaseId}" but manifest declares "${manifestReleaseId}"`,
          );
        }
      }
    }

    // ── 8. Per-contract pure validation ───────────────────────────────────
    const deploymentFloor =
      typeof manifest.deploymentFloor === 'number' &&
      Number.isInteger(manifest.deploymentFloor) &&
      manifest.deploymentFloor >= 0
        ? manifest.deploymentFloor
        : 0;

    const contractResults: ManifestContractValidationResult[] = [];
    for (const contract of manifest.contracts) {
      const result = this.validateContractEntry(contract, deploymentFloor);
      contractResults.push(result);
      if (!result.valid) {
        errors.push(
          `contract "${result.name}" (${result.address}): ` +
            result.errors.join('; '),
        );
      }
    }

    // ── 9. Optional on-chain code verification ────────────────────────────
    if (
      this.configService.get<string>('BLOCKCHAIN_STARTUP_RPC_CHECK') !== 'false'
    ) {
      const rpcErrors = await this.verifyOnChain(
        manifest.contracts,
        manifest.chainId,
      );
      errors.push(...rpcErrors);
    }

    return {
      valid: errors.length === 0,
      version: manifest.version ?? 'unknown',
      releaseId: manifest.releaseId ?? 'unknown',
      chainId: manifest.chainId ?? 0,
      contractCount: manifest.contracts.length,
      contractResults,
      errors,
      manifestAgedays: manifestAgeDays,
    };
  }

  /**
   * Pure (no I/O) validation of a single contract entry.
   *
   * @param contract  The contract entry to validate.
   * @param deploymentFloor  Minimum allowed deployBlock (from manifest level).
   *                         Defaults to 0 (no floor).
   */
  validateContractEntry(
    contract: ManifestContractEntry,
    deploymentFloor = 0,
  ): ManifestContractValidationResult {
    const errors: string[] = [];
    const name = contract?.name ?? '<unnamed>';
    const address = contract?.address ?? '';

    // Address shape
    if (!address) {
      errors.push('missing address');
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      errors.push(`"${address}" is not a valid 20-byte hex address`);
    } else {
      // Zero / dummy address
      if (address === '0x0000000000000000000000000000000000000000') {
        errors.push('zero address is prohibited');
      }
      // EIP-55 checksum
      try {
        const checksummed = ethers.getAddress(address);
        if (checksummed !== address) {
          errors.push(
            `address is not EIP-55 checksummed (expected ${checksummed})`,
          );
        }
      } catch (err) {
        errors.push(`address checksum failed: ${String(err)}`);
      }
    }

    // deployBlock
    if (
      typeof contract.deployBlock !== 'number' ||
      !Number.isInteger(contract.deployBlock) ||
      contract.deployBlock < 0
    ) {
      errors.push(
        `deployBlock must be a non-negative integer (got ${contract.deployBlock})`,
      );
    } else if (contract.deployBlock < deploymentFloor) {
      // Deployment-floor enforcement
      errors.push(
        `deployBlock ${contract.deployBlock} is below the manifest deploymentFloor ${deploymentFloor}`,
      );
    }

    // Events presence
    if (!Array.isArray(contract.events) || contract.events.length === 0) {
      errors.push('at least one event fragment is required');
    } else {
      // Per-event ABI validation + optional topic0 cross-check
      for (const event of contract.events) {
        if (!event.abi) {
          errors.push(`event "${event.name}" has no ABI string`);
          continue;
        }
        try {
          const fragment = ethers.Fragment.from(event.abi);
          if (fragment.type !== 'event') {
            errors.push(
              `event "${event.name}" ABI parses as "${fragment.type}", expected "event"`,
            );
          } else if (event.topic0) {
            // Cross-check the declared topic0 against the ABI-derived topic0.
            const eventFragment = fragment as ethers.EventFragment;
            const derivedTopic0 = ethers.id(eventFragment.format('sighash'));
            const normalizedDeclared = event.topic0.toLowerCase();
            if (derivedTopic0.toLowerCase() !== normalizedDeclared) {
              errors.push(
                `event "${event.name}" topic0 mismatch: ` +
                  `declared ${normalizedDeclared} but ABI derives ${derivedTopic0.toLowerCase()}`,
              );
            }
          }
        } catch (err) {
          errors.push(`event "${event.name}" ABI is invalid: ${String(err)}`);
        }
      }

      // Per-contract ABI checksum
      if (contract.abiChecksum) {
        const computed = createHash('sha256')
          .update(JSON.stringify(contract.events))
          .digest('hex');
        if (computed !== contract.abiChecksum) {
          errors.push(
            `ABI checksum mismatch: computed ${computed}, declared ${contract.abiChecksum}`,
          );
        }
      }
    }

    // Proxy provenance all-or-nothing
    if (contract.proxy !== undefined && contract.proxy !== null) {
      const { proxyAdmin, implementationAddress, implementationCodeHash } =
        contract.proxy;
      const presentFields = [
        proxyAdmin ? 'proxyAdmin' : null,
        implementationAddress ? 'implementationAddress' : null,
        implementationCodeHash ? 'implementationCodeHash' : null,
      ].filter(Boolean);

      if (presentFields.length > 0 && presentFields.length < 3) {
        const missingFields = [
          'proxyAdmin',
          'implementationAddress',
          'implementationCodeHash',
        ].filter(
          (f) =>
            !contract.proxy![f as keyof typeof contract.proxy] ||
            contract.proxy![f as keyof typeof contract.proxy] === '',
        );
        errors.push(
          `proxy provenance is incomplete — all-or-nothing required; ` +
            `missing: ${missingFields.join(', ')}`,
        );
      } else if (presentFields.length === 3) {
        // Validate proxyAdmin address shape + checksum
        this.validateProxyAddress(proxyAdmin, 'proxyAdmin', errors);
        // Validate implementationAddress shape + checksum
        this.validateProxyAddress(
          implementationAddress,
          'implementationAddress',
          errors,
        );
        // implementationCodeHash must be a non-empty hex string (0x or bare)
        if (!implementationCodeHash || implementationCodeHash.trim() === '') {
          errors.push('proxy.implementationCodeHash must be a non-empty string');
        }
      }
      // else presentFields.length === 0 — empty proxy object, all-or-nothing
      // accepts empty (no fields provided). Treat as no proxy info.
    }

    return { name, address, valid: errors.length === 0, errors };
  }

  /** Validates an address field within proxy provenance. */
  private validateProxyAddress(
    address: string,
    fieldName: string,
    errors: string[],
  ): void {
    if (!address) {
      errors.push(`proxy.${fieldName} is missing`);
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      errors.push(
        `proxy.${fieldName} "${address}" is not a valid 20-byte hex address`,
      );
      return;
    }
    if (address === '0x0000000000000000000000000000000000000000') {
      errors.push(`proxy.${fieldName} zero address is prohibited`);
      return;
    }
    try {
      const checksummed = ethers.getAddress(address);
      if (checksummed !== address) {
        errors.push(
          `proxy.${fieldName} is not EIP-55 checksummed (expected ${checksummed})`,
        );
      }
    } catch (err) {
      errors.push(`proxy.${fieldName} checksum failed: ${String(err)}`);
    }
  }

  /**
   * On-chain verification: checks RPC chain ID, deployed bytecode presence
   * (EOA rejection), and proxy implementation code hash (when proxy provenance
   * is present). Skipped when BLOCKCHAIN_STARTUP_RPC_CHECK=false.
   */
  private async verifyOnChain(
    contracts: ManifestContractEntry[],
    expectedChainId: number,
  ): Promise<string[]> {
    const errors: string[] = [];
    const rpcUrl = this.configService.get<string>(
      'OPTIMISM_RPC_URL',
      'https://mainnet.optimism.io',
    );

    let provider: ethers.JsonRpcProvider;
    try {
      provider = new ethers.JsonRpcProvider(rpcUrl);
      const network = await provider.getNetwork();
      const observedChainId = Number(network.chainId);
      if (observedChainId !== expectedChainId) {
        errors.push(
          `RPC chain ID ${observedChainId} does not match manifest chainId ${expectedChainId}`,
        );
        // Chain ID mismatch is fatal — skip per-address code checks.
        return errors;
      }
    } catch (err) {
      errors.push(`RPC unreachable at ${rpcUrl}: ${String(err)}`);
      return errors;
    }

    for (const contract of contracts) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
        // Shape errors already reported by pure validation; skip here.
        continue;
      }

      // EOA rejection: ensure contract bytecode exists.
      try {
        const code = await provider.getCode(contract.address);
        if (!code || code === '0x' || code === '0x0') {
          errors.push(
            `no contract bytecode at ${contract.address} (${contract.name}) — ` +
              `address is an EOA or not deployed on chain ${expectedChainId}`,
          );
          // Skip proxy check for EOA addresses.
          continue;
        }
      } catch (err) {
        errors.push(
          `eth_getCode failed for ${contract.address} (${contract.name}): ${String(err)}`,
        );
        continue;
      }

      // Proxy implementation code hash verification.
      if (
        contract.proxy?.proxyAdmin &&
        contract.proxy?.implementationAddress &&
        contract.proxy?.implementationCodeHash
      ) {
        const implAddr = contract.proxy.implementationAddress;
        if (!/^0x[a-fA-F0-9]{40}$/.test(implAddr)) {
          // Shape errors already caught in pure validation; skip.
          continue;
        }
        try {
          const implCode = await provider.getCode(implAddr);
          if (!implCode || implCode === '0x' || implCode === '0x0') {
            errors.push(
              `proxy implementation at ${implAddr} (${contract.name}) has no bytecode — ` +
                `stale proxy or implementation not deployed on chain ${expectedChainId}`,
            );
            continue;
          }
          // keccak256 of the implementation bytecode
          const actualHash = ethers.keccak256(ethers.toUtf8Bytes(implCode));
          // Normalise both to lowercase for comparison.
          const declaredHash =
            contract.proxy.implementationCodeHash.toLowerCase();
          if (actualHash.toLowerCase() !== declaredHash) {
            errors.push(
              `proxy implementation code-hash mismatch for ${contract.name}: ` +
                `declared ${declaredHash} but on-chain keccak256 is ${actualHash.toLowerCase()} — ` +
                `possible stale proxy or unauthorized implementation swap`,
            );
          }
        } catch (err) {
          errors.push(
            `eth_getCode failed for proxy implementation ${implAddr} ` +
              `(${contract.name}): ${String(err)}`,
          );
        }
      }
    }

    return errors;
  }

  /**
   * Compute the SHA-256 checksum for a given contracts array.
   * Utility exposed so operators can pre-compute checksums for manifest files.
   */
  computeManifestChecksum(contracts: ManifestContractEntry[]): string {
    return createHash('sha256').update(JSON.stringify(contracts)).digest('hex');
  }

  /**
   * Compute the per-contract ABI checksum.
   * Utility exposed so operators can pre-compute checksums for individual contracts.
   */
  computeAbiChecksum(events: ManifestContractEntry['events']): string {
    return createHash('sha256').update(JSON.stringify(events)).digest('hex');
  }
}
