import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';

/**
 * Result of validating indexed field layout consistency across event versions.
 */
export interface IndexedFieldValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Result of collision detection for event topics and function selectors.
 */
export interface CollisionDetectionResult {
  topicCollisions: Array<{ topic: string; events: string[] }>;
  selectorCollisions: Array<{ selector: string; functions: string[] }>;
  hasCollisions: boolean;
}

/**
 * Result of overload detection for events with the same name.
 */
export interface OverloadDetectionResult {
  overloads: Array<{ name: string; signatures: string[] }>;
  hasOverloads: boolean;
}

/**
 * Result of duplicate detection for identical event signatures.
 */
export interface DuplicateDetectionResult {
  duplicates: Array<{ signature: string; count: number }>;
  hasDuplicates: boolean;
}

/**
 * Result of anonymous event detection.
 */
export interface AnonymousEventDetectionResult {
  anonymousEvents: Array<{ name: string; signature: string }>;
  hasAnonymousEvents: boolean;
}

/**
 * Indexed parameter metadata for validation.
 */
export interface IndexedParameter {
  name: string;
  type: string;
  indexed: boolean;
  position: number;
}

/**
 * AbiValidationService
 *
 * Production-grade ABI validation that extends basic schema checks with:
 * - Overload detection: same event name, different signatures
 * - Topic collision detection: different events sharing the same topic0
 * - Selector collision detection: different functions sharing the same selector
 * - Anonymous event detection and validation
 * - Duplicate detection: identical event signatures appearing multiple times
 * - Indexed field layout validation: order, type, and count mutations
 *
 * Design invariants:
 * - Fail closed: any ambiguous, collision-prone, or malformed ABI structure
 *   is rejected at manifest validation time, never at runtime.
 * - Events are keyed by canonical signature/topic0, not name alone.
 * - Indexed field layout mutations (type changes, reordering, count changes)
 *   are detected and flagged as incompatible drift.
 * - Anonymous events (which do not emit topic0) are explicitly flagged.
 * - Topic/selector collisions are detected across the entire manifest.
 */
@Injectable()
export class AbiValidationService {
  private readonly logger = new Logger(AbiValidationService.name);

  /**
   * Detect event overloads: multiple events with the same name but different signatures.
   * Overloaded events are valid in Solidity but require signature-based keying for correct decoding.
   */
  detectEventOverloads(abi: string[]): OverloadDetectionResult {
    const eventsByName = new Map<string, string[]>();

    for (const abiString of abi) {
      try {
        const fragment = ethers.Fragment.from(abiString);
        if (fragment.type === 'event') {
          const eventFragment = fragment as ethers.EventFragment;
          const name = eventFragment.name;
          const signature = eventFragment.format('sighash');

          if (!eventsByName.has(name)) {
            eventsByName.set(name, []);
          }
          eventsByName.get(name)!.push(signature);
        }
      } catch (err) {
        // Skip malformed fragments; they'll be caught by base validation
        continue;
      }
    }

    const overloads: Array<{ name: string; signatures: string[] }> = [];
    for (const [name, signatures] of eventsByName.entries()) {
      const uniqueSignatures = [...new Set(signatures)];
      if (uniqueSignatures.length > 1) {
        overloads.push({ name, signatures: uniqueSignatures });
      }
    }

    return {
      overloads,
      hasOverloads: overloads.length > 0,
    };
  }

  /**
   * Detect topic0 collisions: different event signatures that hash to the same topic0.
   * This is extremely unlikely (cryptographic collision) but must be detected for security.
   *
   * Also detects selector collisions for functions (4-byte function selectors).
   */
  detectCollisions(abi: string[]): CollisionDetectionResult {
    const topicMap = new Map<string, string[]>();
    const selectorMap = new Map<string, string[]>();

    for (const abiString of abi) {
      try {
        const fragment = ethers.Fragment.from(abiString);

        if (fragment.type === 'event') {
          const eventFragment = fragment as ethers.EventFragment;
          const signature = eventFragment.format('sighash');
          const topic0 = ethers.id(signature);

          if (!topicMap.has(topic0)) {
            topicMap.set(topic0, []);
          }
          topicMap.get(topic0)!.push(signature);
        } else if (fragment.type === 'function') {
          const functionFragment = fragment as ethers.FunctionFragment;
          const signature = functionFragment.format('sighash');
          const selector = ethers.id(signature).slice(0, 10); // 0x + 8 hex chars = 4 bytes

          if (!selectorMap.has(selector)) {
            selectorMap.set(selector, []);
          }
          selectorMap.get(selector)!.push(signature);
        }
      } catch (err) {
        // Skip malformed fragments
        continue;
      }
    }

    const topicCollisions: Array<{ topic: string; events: string[] }> = [];
    for (const [topic, events] of topicMap.entries()) {
      if (events.length > 1) {
        topicCollisions.push({ topic, events });
      }
    }

    const selectorCollisions: Array<{ selector: string; functions: string[] }> =
      [];
    for (const [selector, functions] of selectorMap.entries()) {
      if (functions.length > 1) {
        selectorCollisions.push({ selector, functions });
      }
    }

    return {
      topicCollisions,
      selectorCollisions,
      hasCollisions:
        topicCollisions.length > 0 || selectorCollisions.length > 0,
    };
  }

  /**
   * Detect anonymous events: events declared with the `anonymous` keyword.
   * Anonymous events do not emit topic0, which changes how they must be decoded.
   */
  detectAnonymousEvents(abi: string[]): AnonymousEventDetectionResult {
    const anonymousEvents: Array<{ name: string; signature: string }> = [];

    for (const abiString of abi) {
      try {
        const fragment = ethers.Fragment.from(abiString);
        if (fragment.type === 'event') {
          const eventFragment = fragment as ethers.EventFragment;
          if (eventFragment.anonymous) {
            anonymousEvents.push({
              name: eventFragment.name,
              signature: eventFragment.format('sighash'),
            });
          }
        }
      } catch (err) {
        // Skip malformed fragments
        continue;
      }
    }

    return {
      anonymousEvents,
      hasAnonymousEvents: anonymousEvents.length > 0,
    };
  }

  /**
   * Detect duplicate event definitions: identical signatures appearing multiple times.
   * This is almost always a mistake in the ABI or manifest generation.
   */
  detectDuplicates(abi: string[]): DuplicateDetectionResult {
    const signatureCounts = new Map<string, number>();

    for (const abiString of abi) {
      try {
        const fragment = ethers.Fragment.from(abiString);
        if (fragment.type === 'event') {
          const eventFragment = fragment as ethers.EventFragment;
          const signature = eventFragment.format('sighash');
          signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
        }
      } catch (err) {
        // Skip malformed fragments
        continue;
      }
    }

    const duplicates: Array<{ signature: string; count: number }> = [];
    for (const [signature, count] of signatureCounts.entries()) {
      if (count > 1) {
        duplicates.push({ signature, count });
      }
    }

    return {
      duplicates,
      hasDuplicates: duplicates.length > 0,
    };
  }

  /**
   * Extract indexed parameter metadata from an event ABI string.
   * Used for validating indexed field layout consistency across versions.
   */
  extractIndexedParameters(abiString: string): IndexedParameter[] {
    try {
      const fragment = ethers.Fragment.from(abiString);
      if (fragment.type !== 'event') {
        return [];
      }

      const eventFragment = fragment as ethers.EventFragment;
      const indexed: IndexedParameter[] = [];

      eventFragment.inputs.forEach((input, position) => {
        if (input.indexed) {
          indexed.push({
            name: input.name,
            type: input.type,
            indexed: true,
            position,
          });
        }
      });

      return indexed;
    } catch (err) {
      return [];
    }
  }

  /**
   * Validate indexed field layout consistency between two versions of the same event.
   * Detects mutations in indexed parameter order, types, or count.
   *
   * @param oldAbi Previous version ABI string
   * @param newAbi New version ABI string
   * @returns Validation result with errors for any incompatible changes
   */
  validateIndexedFieldLayout(
    oldAbi: string,
    newAbi: string,
  ): IndexedFieldValidationResult {
    const errors: string[] = [];

    const oldIndexed = this.extractIndexedParameters(oldAbi);
    const newIndexed = this.extractIndexedParameters(newAbi);

    // Check count consistency
    if (oldIndexed.length !== newIndexed.length) {
      errors.push(
        `Indexed parameter count changed: ${oldIndexed.length} -> ${newIndexed.length}`,
      );
    }

    // Check position and type consistency for each indexed parameter
    const minLength = Math.min(oldIndexed.length, newIndexed.length);
    for (let i = 0; i < minLength; i++) {
      const oldParam = oldIndexed[i];
      const newParam = newIndexed[i];

      if (oldParam.type !== newParam.type) {
        errors.push(
          `Indexed parameter ${i} type changed: ${oldParam.type} -> ${newParam.type}`,
        );
      }

      if (oldParam.position !== newParam.position) {
        errors.push(
          `Indexed parameter ${i} position changed: ${oldParam.position} -> ${newParam.position}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Compute the canonical topic0 for an event ABI string.
   * Returns null for anonymous events (which don't have topic0).
   */
  computeTopic0(abiString: string): string | null {
    try {
      const fragment = ethers.Fragment.from(abiString);
      if (fragment.type !== 'event') {
        return null;
      }

      const eventFragment = fragment as ethers.EventFragment;
      if (eventFragment.anonymous) {
        return null; // Anonymous events have no topic0
      }

      return ethers.id(eventFragment.format('sighash'));
    } catch (err) {
      return null;
    }
  }

  /**
   * Compute the canonical signature for an event ABI string.
   * Format: EventName(type1,type2,...)
   */
  computeCanonicalSignature(abiString: string): string | null {
    try {
      const fragment = ethers.Fragment.from(abiString);
      if (fragment.type !== 'event') {
        return null;
      }

      const eventFragment = fragment as ethers.EventFragment;
      return eventFragment.format('sighash');
    } catch (err) {
      return null;
    }
  }

  /**
   * Validate that an event name is unique within a contract, or if overloaded,
   * that all overloads are properly distinguished by their full signatures.
   *
   * This is a convenience method that combines overload detection with
   * validation logic suitable for integration into manifest validation.
   */
  validateEventNaming(abi: string[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const overloadResult = this.detectEventOverloads(abi);
    if (overloadResult.hasOverloads) {
      // Overloads are valid, but we need to ensure each has a distinct topic0
      for (const overload of overloadResult.overloads) {
        const topics = new Set<string>();
        for (const signature of overload.signatures) {
          const topic0 = this.computeTopic0(`event ${signature}`);
          if (topic0) {
            topics.add(topic0);
          }
        }

        // If we have fewer unique topics than signatures, there's a collision
        if (topics.size !== overload.signatures.length) {
          errors.push(
            `Event "${overload.name}" has overloaded signatures but topic0 collision detected`,
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate that a manifest's event set does not contain any production-blocking issues:
   * - No topic0 collisions
   * - No selector collisions
   * - Duplicates are detected and reported
   * - Anonymous events are flagged for explicit review
   * - Overloads are valid (distinct topic0 for each signature)
   */
  validateManifestEventSet(
    abi: string[],
  ): { valid: boolean; warnings: string[]; errors: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for collisions (hard errors)
    const collisionResult = this.detectCollisions(abi);
    if (collisionResult.topicCollisions.length > 0) {
      for (const collision of collisionResult.topicCollisions) {
        errors.push(
          `Topic0 collision detected for ${collision.topic}: ${collision.events.join(', ')}`,
        );
      }
    }
    if (collisionResult.selectorCollisions.length > 0) {
      for (const collision of collisionResult.selectorCollisions) {
        errors.push(
          `Selector collision detected for ${collision.selector}: ${collision.functions.join(', ')}`,
        );
      }
    }

    // Check for duplicates (hard errors)
    const duplicateResult = this.detectDuplicates(abi);
    if (duplicateResult.hasDuplicates) {
      for (const duplicate of duplicateResult.duplicates) {
        errors.push(
          `Duplicate event signature: ${duplicate.signature} appears ${duplicate.count} times`,
        );
      }
    }

    // Check for anonymous events (warnings - require explicit review)
    const anonymousResult = this.detectAnonymousEvents(abi);
    if (anonymousResult.hasAnonymousEvents) {
      for (const event of anonymousResult.anonymousEvents) {
        warnings.push(
          `Anonymous event detected: ${event.name} (${event.signature}) - requires explicit decoding logic`,
        );
      }
    }

    // Check for overloads and validate they don't cause collisions
    const overloadResult = this.detectEventOverloads(abi);
    if (overloadResult.hasOverloads) {
      for (const overload of overloadResult.overloads) {
        warnings.push(
          `Event overload detected: ${overload.name} has ${overload.signatures.length} signatures`,
        );
      }

      // Validate overloads don't cause collisions
      const namingValidation = this.validateEventNaming(abi);
      if (!namingValidation.valid) {
        errors.push(...namingValidation.errors);
      }
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }
}
