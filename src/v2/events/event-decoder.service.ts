import { Injectable } from '@nestjs/common';
import { Interface, LogDescription } from 'ethers';
import {
  RawLog,
  NormalizedEvent,
} from './interfaces/canonical-event.interface';
import {
  EVENT_SCHEMA_REGISTRY,
  KNOWN_EVENT_NAMES,
} from './event-schema-registry';

export type DecodeResult =
  | { status: 'decoded'; description: LogDescription; signature: string; topic0: string | null }
  | { status: 'unknown_signature'; topic0: string | null }
  | { status: 'decode_error'; error: string; topic0: string | null };

export type NormalizeResult =
  | { status: 'normalized'; event: NormalizedEvent }
  | { status: 'artifact_drift'; eventName: string };

/** JSON-safe conversion: bigint -> decimal string, recursively. */
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

export function argsToObject(description: LogDescription): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  description.fragment.inputs.forEach((input, index) => {
    const name = input.name || `arg${index}`;
    out[name] = toJsonSafe(description.args[index]);
  });
  return out;
}

@Injectable()
export class EventDecoderService {
  /**
   * Attempt to decode a raw log against the given ABI. Never throws.
   * 
   * Events are now keyed by canonical signature/topic0 instead of name alone
   * to properly support overloaded events and detect drift.
   */
  decode(log: RawLog, iface: Interface): DecodeResult {
    const topic0 = log.topics[0] ?? null;
    
    try {
      const description = iface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (!description) {
        return { status: 'unknown_signature', topic0 };
      }
      
      // Compute canonical signature for event keying
      const signature = description.fragment.format('sighash');
      
      return { status: 'decoded', description, signature, topic0 };
    } catch (err) {
      return {
        status: 'decode_error',
        error: err instanceof Error ? err.message : String(err),
        topic0,
      };
    }
  }

  /**
   * Map a successfully decoded log to the canonical normalized shape.
   * Returns `artifact_drift` if the ABI decoded an event name this pipeline
   * has no canonical mapping for yet, since that is a real signal the
   * approved artifact has moved ahead of what's been reviewed here.
   * 
   * Events are keyed by canonical signature to support overloads.
   */
  normalize(
    log: RawLog,
    artifactVersion: string,
    description: LogDescription,
    signature: string,
  ): NormalizeResult {
    const { name } = description;
    
    // For overloaded events, we need to check the signature-based mapping first
    // Fall back to name-based mapping for backward compatibility
    const mappingKey = KNOWN_EVENT_NAMES.has(signature) ? signature : name;
    
    if (!KNOWN_EVENT_NAMES.has(mappingKey)) {
      return { status: 'artifact_drift', eventName: name };
    }

    const args = argsToObject(description);
    const mapping = EVENT_SCHEMA_REGISTRY[mappingKey];

    const pick = (argName?: string): string | null => {
      if (!argName) return null;
      const value = args[argName];
      if (value === undefined || value === null) return null;
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    };

    const event: NormalizedEvent = {
      chainId: log.chainId,
      contractAddress: log.address.toLowerCase(),
      artifactVersion,
      eventName: name,
      eventSignature: signature,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockTimestamp: log.blockTimestamp ?? null,
      actor: pick(mapping.actor)?.toLowerCase() ?? null,
      claimId: pick(mapping.claimId),
      roundId: pick(mapping.roundId),
      asset: pick(mapping.asset)?.toLowerCase() ?? null,
      amount: pick(mapping.amount),
      payload: args,
      rawArgs: args,
    };

    return { status: 'normalized', event };
  }
}
