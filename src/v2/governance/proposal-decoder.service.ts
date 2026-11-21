import { Injectable, Logger } from '@nestjs/common';
import {
  AbiCoder,
  Interface,
  FunctionFragment,
  dataSlice,
  getAddress,
  keccak256,
} from 'ethers';
import * as crypto from 'crypto';

export const GOVERNOR_PROPOSAL_HASH_SCHEME = 'OZ_GOVERNOR_DESCRIPTION_HASH_V1';

export interface ProposalHashInput {
  targets: string[];
  values: string[];
  calldatas: string[];
  descriptionHash: string;
  expectedProposalId: string;
  artifactVersion: string;
}

export type ProposalHashVerification =
  | {
      ok: true;
      proposalHash: string;
      descriptionHash: string;
      scheme: string;
      artifactVersion: string;
    }
  | { ok: false; reason: string };

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

  computeProposalHash(
    targets: string[],
    values: string[],
    calldatas: string[],
    descriptionHash: string,
  ): string {
    const normalized = this.normalizeProposalHashInput({
      targets,
      values,
      calldatas,
      descriptionHash,
    });
    return this.hashCanonicalCallArrays(normalized);
  }

  verifyProposalHash(input: ProposalHashInput): ProposalHashVerification {
    if (
      typeof input.artifactVersion !== 'string' ||
      input.artifactVersion.trim() === ''
    ) {
      return { ok: false, reason: 'missing artifactVersion' };
    }

    let normalized: NormalizedProposalHashInput;
    let expected: bigint;
    try {
      normalized = this.normalizeProposalHashInput(input);
      expected = parseProposalId(input.expectedProposalId);
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }

    const proposalHash = this.hashCanonicalCallArrays(normalized);
    if (BigInt(proposalHash) !== expected) {
      return { ok: false, reason: 'computed hash does not match proposalId' };
    }

    return {
      ok: true,
      proposalHash,
      descriptionHash: normalized.descriptionHash,
      scheme: GOVERNOR_PROPOSAL_HASH_SCHEME,
      artifactVersion: input.artifactVersion,
    };
  }

  private hashCanonicalCallArrays(input: NormalizedProposalHashInput): string {
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint256[]', 'bytes[]', 'bytes32'],
      [
        input.targets,
        input.values,
        input.calldatas,
        input.descriptionHash,
      ],
    );
    return keccak256(encoded);
  }

  private normalizeProposalHashInput(input: {
    targets: string[];
    values: string[];
    calldatas: string[];
    descriptionHash: string;
  }): NormalizedProposalHashInput {
    const { targets, values, calldatas, descriptionHash } = input;
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('targets must be a non-empty array');
    }
    if (!Array.isArray(values) || values.length !== targets.length) {
      throw new Error('values must be an array matching targets length');
    }
    if (!Array.isArray(calldatas) || calldatas.length !== targets.length) {
      throw new Error('calldatas must be an array matching targets length');
    }
    if (
      typeof descriptionHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(descriptionHash)
    ) {
      throw new Error('descriptionHash must be 32-byte hex');
    }

    const normalizedTargets = targets.map((target) => {
      if (typeof target !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
        throw new Error('target must be a 20-byte hex address');
      }
      return getAddress(target);
    });

    const normalizedValues = values.map((value) => {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error('value must be a non-negative decimal string');
      }
      return BigInt(value).toString();
    });

    const normalizedCalldatas = calldatas.map((calldata) => {
      if (typeof calldata !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata)) {
        throw new Error('calldata must be even-length 0x-prefixed hex');
      }
      return calldata.toLowerCase();
    });

    return {
      targets: normalizedTargets,
      values: normalizedValues,
      calldatas: normalizedCalldatas,
      descriptionHash: descriptionHash.toLowerCase(),
    };
  }
}

interface NormalizedProposalHashInput {
  targets: string[];
  values: string[];
  calldatas: string[];
  descriptionHash: string;
}

function parseProposalId(value: string): bigint {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('proposalId is missing');
  }
  if (/^0x[0-9a-fA-F]+$/.test(value) || /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new Error('proposalId must be a uint256 decimal or 0x-prefixed hex string');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
