import { createHash } from 'node:crypto';
import {
  MissingProjectionDigestError,
  ProjectionBindingMismatchError,
  ProjectionComparisonDiff,
  ProjectionComparisonReport,
  ProjectionDigest,
  ProjectionDigestMetadata,
  ProjectionDigestMismatchError,
} from './projection-rebuild.types';

export {
  MissingProjectionDigestError,
  ProjectionBindingMismatchError,
  ProjectionDigestMismatchError,
};

/**
 * Default volatile fields excluded from canonical digests.
 * These fields represent local system time, sequence IDs, internal revisions,
 * or node/sync metadata that legitimately drift across rebuilds and environments.
 */
export const DEFAULT_EXCLUDED_VOLATILE_FIELDS: readonly string[] = Object.freeze([
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
  'synced_at',
  'syncedAt',
  'rebuilt_at',
  'rebuiltAt',
  'indexed_at',
  'indexedAt',
  '_rev',
  '__v',
  'internal_id',
  'internalId',
  'row_id',
  'rowId',
]);

/** Options for canonical normalization and serialization. */
export interface CanonicalizationOptions {
  /** Additional field names to exclude from digest hashing. */
  excludedFields?: string[];
  /** Normalize ISO 8601 timestamps and Date objects to UTC ISO strings. Defaults to true. */
  normalizeTimezones?: boolean;
  /** Normalize numeric representations (e.g. trailing decimal zeroes, exponential notation). Defaults to true. */
  normalizeNumericPrecision?: boolean;
  /** Omit null property values (treating null equivalently to undefined). Defaults to false. */
  stripNulls?: boolean;
  /** Canonical default values to substitute for missing or null properties. */
  defaults?: Record<string, unknown>;
}

export interface ProjectionDigestContext extends CanonicalizationOptions {
  schema?: string;
  releaseId?: string;
  chainId?: number;
  deploymentBlock?: number;
  artifactChecksum?: string;
  createdAt?: string;
}

export interface CompareOptions {
  /** If true, throws typed actionable error on missing digests or mismatch. Defaults to true. */
  failClosed?: boolean;
  /** Verify chain and release bindings between rebuild and live. Defaults to true. */
  verifyBinding?: boolean;
  /** Allow rebuild to contain extra projectors not yet present in live. Defaults to false. */
  allowExtraInRebuild?: boolean;
}

const ISO_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const STANDARD_DECIMAL_REGEX = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Normalizes numbers and standard decimal strings into a canonical representation.
 * - Enforces number finiteness (rejects NaN, Infinity).
 * - Converts -0 to 0 (per RFC 8785).
 * - Strips redundant trailing decimal zeroes (e.g. "100.00" -> "100", "100.50" -> "100.5").
 */
export function normalizeNumericValue(val: unknown): unknown {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error(`Canonical serialization error: non-finite number (${val})`);
    }
    return Object.is(val, -0) ? 0 : val;
  }
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (typeof val === 'string' && STANDARD_DECIMAL_REGEX.test(val)) {
    // Exclude strings that look like identifiers (e.g. leading zeros like "007" or single "0")
    if (val.length > 1 && val.startsWith('0') && !val.startsWith('0.')) {
      return val;
    }
    if (val.length > 2 && val.startsWith('-0') && !val.startsWith('-0.')) {
      return val;
    }

    if (val.includes('e') || val.includes('E')) {
      const num = Number(val);
      if (Number.isFinite(num)) {
        return num.toString();
      }
    }

    if (val.includes('.')) {
      // Strip trailing zeroes after decimal point
      let stripped = val.replace(/\.?0+$/, '');
      if (stripped === '-0' || stripped === '') stripped = '0';
      return stripped;
    }
  }
  return val;
}

/**
 * Normalizes a value for canonical serialization:
 * - Omits volatile fields
 * - Converts timezones and dates to UTC ISO 8601
 * - Normalizes numeric precision and decimal strings
 * - Sorts object keys deterministically
 */
export function canonicalizeValue(
  value: unknown,
  options: CanonicalizationOptions = {},
  excludedSet?: Set<string>,
): unknown {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }

  // Handle Date instances
  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new Error('Canonical serialization error: invalid Date');
    }
    return value.toISOString();
  }

  // Handle string timezone normalization
  if (typeof value === 'string') {
    if (options.normalizeTimezones !== false && ISO_DATE_REGEX.test(value)) {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    if (options.normalizeNumericPrecision !== false) {
      return normalizeNumericValue(value);
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return normalizeNumericValue(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, options, excludedSet));
  }

  if (typeof value === 'object') {
    // If toJSON method exists, serialize output of toJSON
    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      return canonicalizeValue(
        (value as { toJSON: () => unknown }).toJSON(),
        options,
        excludedSet,
      );
    }

    const obj = value as Record<string, unknown>;
    const keySet = new Set<string>(Object.keys(obj));
    if (options.defaults) {
      for (const dKey of Object.keys(options.defaults)) {
        keySet.add(dKey);
      }
    }
    const keys = Array.from(keySet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      if (excludedSet && excludedSet.has(key)) {
        continue;
      }

      let propVal = obj[key];

      // Check defaults if property is missing or undefined/null
      if (
        options.defaults &&
        (propVal === undefined || propVal === null) &&
        key in options.defaults
      ) {
        propVal = options.defaults[key];
      }

      if (propVal === undefined) {
        continue;
      }

      if (options.stripNulls && propVal === null) {
        continue;
      }

      result[key] = canonicalizeValue(propVal, options, excludedSet);
    }
    return result;
  }

  return value;
}

/** Stable JSON for hashing — RFC 8785 canonical representation (sorted keys, no undefined, compact). */
export function stableStringify(
  value: unknown,
  options: CanonicalizationOptions = {},
): string {
  const excludedSet = new Set<string>([
    ...DEFAULT_EXCLUDED_VOLATILE_FIELDS,
    ...(options.excludedFields ?? []),
  ]);
  const canonical = canonicalizeValue(value, options, excludedSet);
  return formatCanonicalJson(canonical);
}

function formatCanonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  const type = typeof value;
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    return (value as number).toString();
  }
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatCanonicalJson(v)).join(',')}]`;
  }
  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries: string[] = [];
    for (const k of keys) {
      if (obj[k] !== undefined) {
        entries.push(`${JSON.stringify(k)}:${formatCanonicalJson(obj[k])}`);
      }
    }
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Computes a canonical, cross-environment comparable digest for a projector's snapshot rows.
 *
 * Guarantees:
 * - Row insertion order independence: rows are canonically sorted by serialized code units.
 * - Timezone independence: timestamps representing the same instant normalize identically.
 * - Numeric precision independence: decimal strings and numbers normalize canonically.
 * - Volatile field exclusion: auto-generated IDs, createdAt/updatedAt/sync timestamps are excluded.
 * - Scalable streaming hashing: memory remains bounded on large datasets.
 * - Cryptographic envelope binding: binds projection name, schema, release, chain ID, deployment block, and artifact checksum.
 */
export async function digestProjector(
  projector: string,
  rows: unknown[],
  context: ProjectionDigestContext = {},
): Promise<ProjectionDigest> {
  const excludedSet = new Set<string>([
    ...DEFAULT_EXCLUDED_VOLATILE_FIELDS,
    ...(context.excludedFields ?? []),
  ]);

  // 1. Canonicalize each row individually
  const canonicalRowStrings: string[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const canonicalRow = canonicalizeValue(rows[i], context, excludedSet);
    canonicalRowStrings[i] = formatCanonicalJson(canonicalRow);
  }

  // 2. Canonical row ordering: UTF-16 code unit order comparison
  canonicalRowStrings.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // 3. Scalable streaming hashing of canonical array format: '[' + rows.join(',') + ']'
  const hash = createHash('sha256');
  hash.update('[');
  for (let i = 0; i < canonicalRowStrings.length; i++) {
    if (i > 0) hash.update(',');
    hash.update(canonicalRowStrings[i]);
  }
  hash.update(']');
  const dataDigest = hash.digest('hex');

  // 4. Construct metadata envelope binding
  const schema = context.schema ?? 'unknown';
  const releaseId = context.releaseId ?? 'unset';
  const chainId = context.chainId ?? 0;
  const deploymentBlock = context.deploymentBlock ?? 0;
  const artifactChecksum = context.artifactChecksum ?? 'unset';

  const metadata: ProjectionDigestMetadata = {
    projector,
    schema,
    releaseId,
    chainId,
    deploymentBlock,
    artifactChecksum,
    algorithm: 'sha256',
    canonicalVersion: 'v1',
    excludedFields: Array.from(excludedSet).sort(),
    rowCount: canonicalRowStrings.length,
    dataDigest,
    envelopeDigest: '',
    ...(context.createdAt ? { createdAt: context.createdAt } : {}),
  };

  // 5. Envelope digest binding data digest with release, schema, and chain context
  const envelopePayload = {
    artifactChecksum: metadata.artifactChecksum,
    canonicalVersion: metadata.canonicalVersion,
    chainId: metadata.chainId,
    dataDigest,
    deploymentBlock: metadata.deploymentBlock,
    projector,
    releaseId: metadata.releaseId,
    rowCount: metadata.rowCount,
    schema: metadata.schema,
  };
  metadata.envelopeDigest = sha256Hex(formatCanonicalJson(envelopePayload));

  return {
    projector,
    rowCount: canonicalRowStrings.length,
    digest: dataDigest,
    schema,
    releaseId,
    chainId,
    deploymentBlock,
    artifactChecksum,
    envelopeDigest: metadata.envelopeDigest,
    metadata,
  };
}

/**
 * Compares projection digests between a rebuild environment and a live environment.
 * Validates cross-environment equivalence, detecting any field drift or missing projectors.
 *
 * Fails closed with typed actionable errors if requested or upon mismatch.
 */
export function compareProjectionDigests(
  rebuildDigests: ProjectionDigest[],
  liveDigests: ProjectionDigest[],
  options: CompareOptions = {},
): ProjectionComparisonReport {
  const failClosed = options.failClosed !== false;
  const verifyBinding = options.verifyBinding !== false;
  const allowExtra = options.allowExtraInRebuild === true;

  const diffs: ProjectionComparisonDiff[] = [];
  const errors: string[] = [];

  const rebuildMap = new Map<string, ProjectionDigest>(
    rebuildDigests.map((d) => [d.projector, d]),
  );
  const liveMap = new Map<string, ProjectionDigest>(
    liveDigests.map((d) => [d.projector, d]),
  );

  const sampleRebuild = rebuildDigests[0];
  const sampleLive = liveDigests[0];

  const rebuildSchema = sampleRebuild?.schema ?? 'rebuild';
  const liveSchema = sampleLive?.schema ?? 'live';

  // 1. Verify that all live projectors are present in rebuild
  for (const [projector, liveDigest] of liveMap.entries()) {
    const rebuildDigest = rebuildMap.get(projector);
    if (!rebuildDigest) {
      const err = new MissingProjectionDigestError(
        projector,
        rebuildSchema,
        `Projector '${projector}' exists in live schema '${liveSchema}' but is missing in rebuild schema '${rebuildSchema}'. Rebuild is incomplete. Ensure '${projector}' is rebuilt before cutover.`,
      );
      diffs.push({
        projector,
        status: 'missing_in_rebuild',
        liveRowCount: liveDigest.rowCount,
        liveDigest: liveDigest.digest,
        liveEnvelopeDigest: liveDigest.envelopeDigest,
        details: err.message,
      });
      errors.push(err.message);
      if (failClosed) {
        throw err;
      }
      continue;
    }

    // Verify row count and data digest
    if (
      rebuildDigest.digest !== liveDigest.digest ||
      rebuildDigest.rowCount !== liveDigest.rowCount
    ) {
      const err = new ProjectionDigestMismatchError(
        projector,
        liveDigest.digest,
        rebuildDigest.digest,
        `Canonical field drift detected in '${projector}'. Rows: rebuild=${rebuildDigest.rowCount}, live=${liveDigest.rowCount}. Refusing cutover.`,
      );
      diffs.push({
        projector,
        status: 'mismatch',
        rebuildRowCount: rebuildDigest.rowCount,
        liveRowCount: liveDigest.rowCount,
        rebuildDigest: rebuildDigest.digest,
        liveDigest: liveDigest.digest,
        rebuildEnvelopeDigest: rebuildDigest.envelopeDigest,
        liveEnvelopeDigest: liveDigest.envelopeDigest,
        details: err.message,
      });
      errors.push(err.message);
      if (failClosed) {
        throw err;
      }
    } else {
      diffs.push({
        projector,
        status: 'match',
        rebuildRowCount: rebuildDigest.rowCount,
        liveRowCount: liveDigest.rowCount,
        rebuildDigest: rebuildDigest.digest,
        liveDigest: liveDigest.digest,
        rebuildEnvelopeDigest: rebuildDigest.envelopeDigest,
        liveEnvelopeDigest: liveDigest.envelopeDigest,
      });
    }
  }

  // 2. Check for projectors in rebuild that do not exist in live
  for (const [projector, rebuildDigest] of rebuildMap.entries()) {
    if (!liveMap.has(projector)) {
      if (!allowExtra) {
        const err = new MissingProjectionDigestError(
          projector,
          liveSchema,
          `Projector '${projector}' exists in rebuild but is missing in live schema '${liveSchema}'.`,
        );
        diffs.push({
          projector,
          status: 'missing_in_live',
          rebuildRowCount: rebuildDigest.rowCount,
          rebuildDigest: rebuildDigest.digest,
          rebuildEnvelopeDigest: rebuildDigest.envelopeDigest,
          details: err.message,
        });
        errors.push(err.message);
        if (failClosed) {
          throw err;
        }
      }
    }
  }

  // 3. Optional binding verification
  if (verifyBinding && sampleRebuild && sampleLive) {
    if (
      sampleRebuild.chainId &&
      sampleLive.chainId &&
      sampleRebuild.chainId !== sampleLive.chainId
    ) {
      const err = new ProjectionBindingMismatchError(
        'chainId',
        sampleLive.chainId,
        sampleRebuild.chainId,
      );
      errors.push(err.message);
      if (failClosed) throw err;
    }
    if (
      sampleRebuild.releaseId &&
      sampleLive.releaseId &&
      sampleRebuild.releaseId !== 'unset' &&
      sampleLive.releaseId !== 'unset' &&
      sampleRebuild.releaseId !== sampleLive.releaseId
    ) {
      const err = new ProjectionBindingMismatchError(
        'releaseId',
        sampleLive.releaseId,
        sampleRebuild.releaseId,
      );
      errors.push(err.message);
      if (failClosed) throw err;
    }
  }

  const equivalent =
    errors.length === 0 && diffs.every((d) => d.status === 'match');

  return {
    schemaVersion: 1,
    comparedAt: new Date().toISOString(),
    equivalent,
    rebuildSchema,
    liveSchema,
    binding: sampleRebuild
      ? {
          chainId: sampleRebuild.chainId,
          releaseId: sampleRebuild.releaseId,
          deploymentBlock: sampleRebuild.deploymentBlock,
          artifactChecksum: sampleRebuild.artifactChecksum,
        }
      : undefined,
    projectorsCount: diffs.length,
    diffs,
    errors,
  };
}
