import { Injectable, Logger } from '@nestjs/common';
import {
  Interface,
  FunctionFragment,
  dataSlice,
  getAddress,
  id as keccakId,
} from 'ethers';
import * as crypto from 'crypto';

const MAX_CALLDATA_BYTES = 1024 * 1024;
const MAX_CALLDATA_HEX_CHARS = MAX_CALLDATA_BYTES * 2 + 2;
const HEX_BODY_PATTERN = /^[0-9a-fA-F]*$/;

type CalldataValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'non-string'
        | 'missing-prefix'
        | 'odd-length'
        | 'non-hex'
        | 'oversized';
      length: number;
    };

function validateCalldata(calldata: unknown): CalldataValidation {
  if (typeof calldata !== 'string') {
    return { ok: false, reason: 'non-string', length: 0 };
  }
  const length = calldata.length;
  if (!calldata.startsWith('0x')) {
    return { ok: false, reason: 'missing-prefix', length };
  }
  if (length > MAX_CALLDATA_HEX_CHARS) {
    return { ok: false, reason: 'oversized', length };
  }
  const body = calldata.slice(2);
  if (body.length % 2 !== 0) {
    return { ok: false, reason: 'odd-length', length };
  }
  if (!HEX_BODY_PATTERN.test(body)) {
    return { ok: false, reason: 'non-hex', length };
  }
  return { ok: true };
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
  /** sha256 of the raw calldata; empty when structural validation failed. */
  calldataChecksum: string;
}

/**
 * ProposalDecoderService — V2-BE-067
 *
 * Decodes a proposal's `calls[]` against an approved ABI. The decoder
 * fails closed:
 *   - Unknown selector  → `selectorUnknown: true`, no parsed args.
 *   - Malformed calldata → same, `selector: null` and an empty
 *     `calldataChecksum` (no checksum is asserted for untrusted bytes).
 *   - Ambiguous/overloaded signature that does not uniquely resolve →
 *     same, but `functionSignature` is left null so callers can detect it.
 *
 * Calldata is validated as a 0x-prefixed, even-length hex byte string and
 * bounded to 1 MiB before any selector is sliced. Warnings never include
 * the calldata itself — only a failure reason and its length.
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
    const isEmptyCalldata =
      typeof calldata === 'string' && (calldata === '' || calldata === '0x');

    const validation = isEmptyCalldata
      ? { ok: true as const }
      : validateCalldata(calldata);
    if (!validation.ok) {
      this.logger.warn(
        `Malformed proposal calldata rejected (${validation.reason}, ` +
          `length=${validation.length}) — failing closed without decoding.`,
      );
      return {
        target,
        valueWei,
        calldata: typeof calldata === 'string' ? calldata : '',
        selector: null,
        functionSignature: null,
        selectorUnknown: true,
        decodedArgs: null,
        calldataChecksum: '',
      };
    }

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
    if (isEmptyCalldata) {
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

    let selector: string;
    try {
      selector = dataSlice(calldata, 0, 4);
    } catch (err) {
      this.logger.warn(
        `Selector extraction failed for proposal call on ${checksummedTarget}: ` +
          `${String(err)} — failing closed.`,
      );
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
    let functionSignature: string;
    try {
      functionSignature = fragment.format('sighash');
    } catch (err) {
      this.logger.warn(
        `Function signature formatting failed for ${selector} on ` +
          `${checksummedTarget}: ${String(err)} — failing closed.`,
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
