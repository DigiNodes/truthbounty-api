import { Injectable, Logger } from '@nestjs/common';
import {
  Interface,
  FunctionFragment,
  dataSlice,
  getAddress,
  id as keccakId,
} from 'ethers';
import * as crypto from 'crypto';

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
    const encoded = new (require('ethers').AbiCoder)().encode(
      ['address[]', 'uint256[]', 'bytes[]', 'bytes32'],
      [targets, values, calldatas, descriptionHash],
    );
    return keccakId(encoded);
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
