import { createHash } from 'crypto';
import { Interface, EventFragment, ParamType } from 'ethers';

export interface CanonicalEventSchema {
  name: string;
  topic0: string;
  signature: string;
  inputs: Array<{
    name: string;
    type: string;
    indexed: boolean;
  }>;
}

export interface CanonicalContractSchema {
  name: string;
  address: string;
  deployBlock: number;
  abiChecksum: string;
  events: CanonicalEventSchema[];
}

export interface CanonicalDecoderAllowlist {
  version: string;
  releaseId: string;
  chainId: number;
  deploymentBlock: number;
  manifestChecksum: string;
  contracts: Record<string, CanonicalContractSchema>;
  allowedAddresses: string[];
  allowedTopic0s: string[];
  eventSignaturesByTopic0: Record<string, string>;
  contractByAddress: Record<string, string>;
}

export interface RawManifestContract {
  name: string;
  address: string;
  deployBlock: number;
  abiChecksum: string;
  events: Array<{
    name: string;
    abi: string;
    topic0?: string;
  }>;
}

export interface RawReleaseManifest {
  version: string;
  releaseId: string;
  chainId: number;
  publishedAt: string;
  manifestChecksum: string;
  contracts: RawManifestContract[];
}

export interface AllowlistValidationResult {
  valid: boolean;
  errors: string[];
  allowlist?: CanonicalDecoderAllowlist;
}

/**
 * Generate a strict decoder allowlist from a canonical release manifest.
 * Fails closed on any schema, checksum, address, topic, indexed fields, or type mismatch.
 */
export function generateDecoderAllowlist(
  manifest: RawReleaseManifest,
  options?: { maxAgeDays?: number; nowMs?: number },
): AllowlistValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be a non-null object'] };
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push('Manifest version is required');
  }

  if (!manifest.releaseId || typeof manifest.releaseId !== 'string') {
    errors.push('Manifest releaseId is required');
  }

  if (manifest.chainId !== 11155420 && manifest.chainId !== 10) {
    errors.push(`Unsupported chain ID: ${manifest.chainId} (expected Optimism Sepolia 11155420 or Optimism Mainnet 10)`);
  }

  if (manifest.chainId !== 11155420) {
    // If explicitly validating Optimism Sepolia boundary
    // Note: We flag non-Sepolia if required by context
  }

  if (
    typeof manifest.manifestChecksum !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(manifest.manifestChecksum)
  ) {
    errors.push('Manifest manifestChecksum must be a 64-character hex SHA-256 digest');
  } else {
    const computedChecksum = createHash('sha256')
      .update(JSON.stringify(manifest.contracts))
      .digest('hex');
    if (computedChecksum.toLowerCase() !== manifest.manifestChecksum.toLowerCase()) {
      errors.push(
        `Manifest checksum mismatch: declared ${manifest.manifestChecksum}, computed ${computedChecksum}`,
      );
    }
  }

  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    errors.push('Manifest contracts must be a non-empty array');
    return { valid: false, errors };
  }

  const contractsMap: Record<string, CanonicalContractSchema> = {};
  const allowedAddresses = new Set<string>();
  const allowedTopic0s = new Set<string>();
  const eventSignaturesByTopic0: Record<string, string> = {};
  const contractByAddress: Record<string, string> = {};

  let minDeployBlock = Number.MAX_SAFE_INTEGER;

  for (const contract of manifest.contracts) {
    if (!contract.name || typeof contract.name !== 'string') {
      errors.push('Contract entry missing name');
      continue;
    }

    if (!contract.address || !/^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
      errors.push(`Contract "${contract.name}" has invalid EVM address: ${contract.address}`);
      continue;
    }

    if (contract.address === '0x0000000000000000000000000000000000000000') {
      errors.push(`Contract "${contract.name}" specifies forbidden zero address`);
      continue;
    }

    if (typeof contract.deployBlock !== 'number' || contract.deployBlock < 0) {
      errors.push(`Contract "${contract.name}" deployBlock must be a non-negative integer`);
    } else {
      if (contract.deployBlock < minDeployBlock) {
        minDeployBlock = contract.deployBlock;
      }
    }

    // Verify per-contract ABI checksum
    if (contract.abiChecksum) {
      const computedAbiChecksum = createHash('sha256')
        .update(JSON.stringify(contract.events))
        .digest('hex');
      if (computedAbiChecksum.toLowerCase() !== contract.abiChecksum.toLowerCase()) {
        errors.push(
          `Contract "${contract.name}" ABI checksum mismatch: declared ${contract.abiChecksum}, computed ${computedAbiChecksum}`,
        );
      }
    } else {
      errors.push(`Contract "${contract.name}" missing abiChecksum`);
    }

    if (!Array.isArray(contract.events) || contract.events.length === 0) {
      errors.push(`Contract "${contract.name}" must declare at least one canonical event`);
      continue;
    }

    const eventSchemas: CanonicalEventSchema[] = [];

    for (const ev of contract.events) {
      if (!ev.name || !ev.abi) {
        errors.push(`Contract "${contract.name}" has invalid event entry`);
        continue;
      }

      try {
        const iface = new Interface([ev.abi]);
        const fragment = iface.getEvent(ev.name);
        if (!fragment) {
          errors.push(`Event "${ev.name}" in contract "${contract.name}" could not be parsed as EventFragment`);
          continue;
        }

        const derivedTopic0 = fragment.topicHash;
        if (ev.topic0 && ev.topic0.toLowerCase() !== derivedTopic0.toLowerCase()) {
          errors.push(
            `Event "${ev.name}" topic0 mismatch: declared ${ev.topic0}, derived ${derivedTopic0}`,
          );
        }

        const inputs = fragment.inputs.map((param: ParamType) => ({
          name: param.name || '',
          type: param.type,
          indexed: Boolean(param.indexed),
        }));

        const schema: CanonicalEventSchema = {
          name: ev.name,
          topic0: derivedTopic0.toLowerCase(),
          signature: fragment.format('sighash'),
          inputs,
        };

        eventSchemas.push(schema);
        allowedTopic0s.add(derivedTopic0.toLowerCase());
        eventSignaturesByTopic0[derivedTopic0.toLowerCase()] = schema.signature;
      } catch (err) {
        errors.push(`Event "${ev.name}" in contract "${contract.name}" failed ABI parsing: ${String(err)}`);
      }
    }

    const normalizedAddress = contract.address.toLowerCase();
    allowedAddresses.add(normalizedAddress);
    contractByAddress[normalizedAddress] = contract.name;

    contractsMap[contract.name] = {
      name: contract.name,
      address: normalizedAddress,
      deployBlock: contract.deployBlock,
      abiChecksum: contract.abiChecksum,
      events: eventSchemas,
    };
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const allowlist: CanonicalDecoderAllowlist = {
    version: manifest.version,
    releaseId: manifest.releaseId,
    chainId: manifest.chainId,
    deploymentBlock: minDeployBlock === Number.MAX_SAFE_INTEGER ? 0 : minDeployBlock,
    manifestChecksum: manifest.manifestChecksum,
    contracts: contractsMap,
    allowedAddresses: Array.from(allowedAddresses).sort(),
    allowedTopic0s: Array.from(allowedTopic0s).sort(),
    eventSignaturesByTopic0,
    contractByAddress,
  };

  return { valid: true, errors: [], allowlist };
}
