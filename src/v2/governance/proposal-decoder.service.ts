import { Injectable, Logger } from '@nestjs/common';
import {
  AbiCoder,
  Interface,
  FunctionFragment,
  dataSlice,
  getAddress,
  getBytes,
  isHexString,
  keccak256,
} from 'ethers';
import * as crypto from 'crypto';
import {
  ALLOWED_CHAIN_IDS,
  AllowedChainId,
} from '../../contracts/contract-manifest.interface';

export const PROPOSAL_HASH_ABI_TYPES = [
  'address[]',
  'uint256[]',
  'bytes[]',
  'bytes32',
] as const;

const UINT256_MAX = (1n << 256n) - 1n;

export interface ProposalHashInput {
  targets: string[];
  values: string[];
  calldatas: string[];
  descriptionHash: string;
}

export interface ProposalHashProvenance {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  governorAddress?: string;
  transactionHash?: string;
  logIndex?: number;
  blockNumber?: number;
}

export interface ProposalHashCrossCheck {
  computedHash: string;
  observedHash: string;
  matches: boolean;
  authoritative: false;
  abiTypes: readonly string[];
  provenance: ProposalHashProvenance;
}

/**
 * Decoded representation of a single call inside a proposal.
 * All hex values are normalised (addresses checksummed, calldata
 * preserved exactly as emitted).
 */
export interface DecodedCall {
  target: string;
  valueWei: string;
  calldata: string;
  selector: string | null;
  functionSignature: string | null;
  selectorUnknown: boolean;
  decodedArgs: Record<string, unknown> | null;
  calldataChecksum: string;
}

/**
 * ProposalDecoderService — V2-BE-067
 *
 * Decodes a proposal's `calls[]` against an approved ABI. The decoder
 * fails closed:
 *   - Unknown selector  → `selectorUnknown: true`, no parsed args.
 *   - Malformed calldata → same, plus a warning.
 *   - Ambiguous/overloaded signature that does not uniquely resolve →
 *     same, but `functionSignature` is left null so callers can detect it.
 *
 * Checksum rules (acceptance criterion: "Exact calls remain decodable and
 * checksummed"):
 *   - The calldata hex is stored exactly as emitted on-chain.
 *   - A sha256 of the raw calldata is returned so consumers can verify.
 *   - Target addresses are EIP-55 checksummed via ethers.getAddress.
 */
@Injectable()
export class ProposalDecoderService {
  private readonly logger = new Logger(ProposalDecoderService.name);

  /**
   * Decode one call.
   *
   * @param target - 20-byte hex address, any case.
   * @param valueWei - value as decimal string (may be '0').
   * @param calldata - 0x-prefixed hex, may be '0x'.
   * @param iface - approved ABI Interface, or null when no artifact is
   *                available for the target. Unknown target → fail closed.
   */
  decodeCall(
    target: string,
    valueWei: string,
    calldata: string,
    iface: Interface | null,
  ): DecodedCall {
    const calldataChecksum = crypto
      .createHash('sha256')
      .update(calldata)
      .digest('hex');

    // Address checksum — throw is unrecoverable, so fail closed with a
    // checksum placeholder that downstream callers can detect.
    let checksummedTarget: string;
    try {
      checksummedTarget = getAddress(target);
    } catch (err) {
      this.logger.warn(
        `Proposal call target is not a valid EIP-55 address: ${target} — ${String(err)}`,
      );
      // Do NOT fabricate. Preserve the raw value and flag it.
      return {
        target,
        valueWei,
        calldata,
        selector: null,
        functionSignature: null,
        selectorUnknown: true,
        decodedArgs: null,
        calldataChecksum,
      };
    }

    // Empty calldata means "plain ETH transfer" — a first-class case.
    if (!calldata || calldata === '0x') {
      return {
        target: checksummedTarget,
        valueWei,
        calldata,
        selector: null,
        functionSignature: null,
        selectorUnknown: false,
        decodedArgs: null,
        calldataChecksum,
      };
    }

    // Too short to contain a selector.
    if (calldata.length < 10) {
      return {
        target: checksummedTarget,
        valueWei,
        calldata,
        selector: null,
        functionSignature: null,
        selectorUnknown: true,
        decodedArgs: null,
        calldataChecksum,
      };
    }

    const selector = dataSlice(calldata, 0, 4);

    // No approved ABI for the target → fail closed.
    if (!iface) {
      this.logger.warn(
        `No approved ABI for proposal call target ${checksummedTarget}; ` +
          `selector ${selector} treated as unknown.`,
      );
      return {
        target: checksummedTarget,
        valueWei,
        calldata,
        selector,
        functionSignature: null,
        selectorUnknown: true,
        decodedArgs: null,
        calldataChecksum,
      };
    }

    // Try to resolve the selector to a unique function fragment.
    let fragment: FunctionFragment | null = null;
    try {
      // Narrow to FunctionFragment via a typed predicate. `Fragment.type`
      // alone does not narrow in TS, so we do an explicit cast *after*
      // checking `type === 'function'`.
      const candidates: FunctionFragment[] = iface.fragments
        .filter((f) => f.type === 'function')
        .map((f) => f as FunctionFragment)
        .filter((f) => f.selector === selector);

      if (candidates.length > 1) {
        // Overloaded selectors collide; refuse to guess. Do not attempt
        // signature-based disambiguation against untrusted calldata.
        this.logger.warn(
          `Ambiguous selector ${selector} on ${checksummedTarget}: ` +
            `${candidates.length} candidate fragments — failing closed.`,
        );
        return {
          target: checksummedTarget,
          valueWei,
          calldata,
          selector,
          functionSignature: null,
          selectorUnknown: true,
          decodedArgs: null,
          calldataChecksum,
        };
      }
      fragment = candidates[0] ?? null;
    } catch (err) {
      this.logger.warn(
        `Selector lookup failed for ${selector} on ${checksummedTarget}: ${String(err)}`,
      );
    }

    if (!fragment) {
      // Genuine unknown selector: not in the approved ABI at all.
      return {
        target: checksummedTarget,
        valueWei,
        calldata,
        selector,
        functionSignature: null,
        selectorUnknown: true,
        decodedArgs: null,
        calldataChecksum,
      };
    }

    // Decode the args; any failure is a fail-closed signal.
    const functionSignature = fragment.format('sighash');
    try {
      const decoded = iface.decodeFunctionData(fragment, calldata);
      const args: Record<string, unknown> = {};
      fragment.inputs.forEach((input, index) => {
        const name = input.name || `arg${index}`;
        args[name] = toJsonSafe(decoded[index]);
      });
      return {
        target: checksummedTarget,
        valueWei,
        calldata,
        selector,
        functionSignature,
        selectorUnknown: false,
        decodedArgs: args,
        calldataChecksum,
      };
    } catch (err) {
      this.logger.warn(
        `Calldata decode failed for ${functionSignature} on ` +
          `${checksummedTarget}: ${String(err)} — failing closed.`,
      );
      return {
        target: checksummedTarget,
        valueWei,
        calldata,
        selector,
        functionSignature,
        selectorUnknown: true,
        decodedArgs: null,
        calldataChecksum,
      };
    }
  }

  /**
   * Compute the proposal hash a Governor would have emitted.
   * Used only to cross-check `ProposalCreated` events; never fabricated
   * as authoritative state.
   */
  computeProposalHash(
    targets: string[],
    values: string[],
    calldatas: string[],
    descriptionHash: string,
  ): string {
    this.validateProposalHashInput({
      targets,
      values,
      calldatas,
      descriptionHash,
    });
    const encoded = AbiCoder.defaultAbiCoder().encode(
      [...PROPOSAL_HASH_ABI_TYPES],
      [targets.map((t) => getAddress(t)), values, calldatas, descriptionHash],
    );
    return keccak256(getBytes(encoded));
  }

  crossCheckProposalHash(
    input: ProposalHashInput,
    observedHash: string,
    provenance: ProposalHashProvenance,
  ): ProposalHashCrossCheck {
    if (!isHexString(observedHash, 32)) {
      throw new Error(
        'Observed proposal hash must be a 0x-prefixed bytes32 value',
      );
    }
    if (!ALLOWED_CHAIN_IDS.includes(provenance.chainId as AllowedChainId)) {
      throw new Error(
        `Proposal hash cross-check chain ${provenance.chainId} is not an approved Optimism chain`,
      );
    }
    if (
      !provenance.releaseId ||
      !Number.isSafeInteger(provenance.deploymentBlock) ||
      !isHexString(provenance.artifactChecksum, 32)
    ) {
      throw new Error(
        'Proposal hash cross-check requires complete release provenance',
      );
    }
    const computedHash = this.computeProposalHash(
      input.targets,
      input.values,
      input.calldatas,
      input.descriptionHash,
    );
    const normalizedObserved = observedHash.toLowerCase();
    return {
      computedHash,
      observedHash: normalizedObserved,
      matches: computedHash === normalizedObserved,
      authoritative: false,
      abiTypes: PROPOSAL_HASH_ABI_TYPES,
      provenance,
    };
  }

  private validateProposalHashInput(input: ProposalHashInput): void {
    const { targets, values, calldatas, descriptionHash } = input;
    if (
      !Array.isArray(targets) ||
      !Array.isArray(values) ||
      !Array.isArray(calldatas)
    ) {
      throw new Error(
        'Proposal hash inputs targets/values/calldatas must be arrays',
      );
    }
    const length = targets.length;
    if (length === 0) {
      throw new Error('Proposal hash inputs must contain at least one call');
    }
    if (values.length !== length || calldatas.length !== length) {
      throw new Error(
        `Proposal hash input length mismatch: ${length} targets, ` +
          `${values.length} values, ${calldatas.length} calldatas`,
      );
    }
    for (const [index, target] of targets.entries()) {
      if (typeof target !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
        throw new Error(
          `Proposal hash target at index ${index} is not a valid address`,
        );
      }
      try {
        getAddress(target);
      } catch {
        throw new Error(
          `Proposal hash target at index ${index} has an invalid EIP-55 checksum`,
        );
      }
    }
    for (const [index, value] of values.entries()) {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(
          `Proposal hash value at index ${index} is not a non-negative decimal uint256`,
        );
      }
      if (BigInt(value) > UINT256_MAX) {
        throw new Error(
          `Proposal hash value at index ${index} exceeds uint256 range`,
        );
      }
    }
    for (const [index, calldata] of calldatas.entries()) {
      if (
        typeof calldata !== 'string' ||
        !isHexString(calldata) ||
        calldata.length % 2 !== 0
      ) {
        throw new Error(
          `Proposal hash calldata at index ${index} is not valid 0x-prefixed hex bytes`,
        );
      }
      getBytes(calldata);
    }
    if (
      typeof descriptionHash !== 'string' ||
      !isHexString(descriptionHash, 32)
    ) {
      throw new Error(
        'Proposal hash descriptionHash must be a 0x-prefixed bytes32 value',
      );
    }
  }
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}
