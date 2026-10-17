import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import {
  compatibilityEnvironment,
  Environment,
  Field,
  parseRuntimeConfig,
  RuntimeConfig,
  runtimeSchema,
} from './runtime-schema';

export interface RuntimeSnapshot {
  readonly config: RuntimeConfig;
  readonly environment: Environment;
}

/** dotenv normally silently keeps the last duplicate assignment. Reject it. */
export function parseEnvironmentFile(source: string): Record<string, string> {
  const seen = new Set<string>();
  // Walk logical assignments, allowing quoted multiline values without treating
  // their contents as further environment assignments.
  const assignment =
    /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*|:\s+)(?:'[^']*'|"(?:\\.|[^"\\])*"|`[^`]*`|[^\r\n]*)/gm;
  for (const match of source.matchAll(assignment)) {
    if (seen.has(match[1]))
      throw new Error(`Duplicate environment variable: ${match[1]}`);
    seen.add(match[1]);
  }
  return parse(source);
}

export function createRuntimeSnapshot(
  environment: Environment,
  files: readonly string[] = [],
  readManifest: (path: string) => Buffer = (path) => readFileSync(path),
): RuntimeSnapshot {
  // Same precedence as Nest: process environment > .env.local > .env.
  const raw: Record<string, string | undefined> = {};
  for (const source of files.slice().reverse())
    Object.assign(raw, parseEnvironmentFile(source));
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined) raw[key] = value;
  const config = parseRuntimeConfig(raw);
  if (config.CONTRACT_RELEASE_MANIFEST_PATH) {
    try {
      const bytes = readManifest(config.CONTRACT_RELEASE_MANIFEST_PATH);
      if (
        !config.CONTRACT_RELEASE_SHA256 ||
        createHash('sha256').update(bytes).digest('hex') !==
          config.CONTRACT_RELEASE_SHA256
      ) {
        throw new Error('checksum mismatch');
      }
      const manifest = JSON.parse(bytes.toString('utf8')) as Record<
        string,
        unknown
      >;
      if (
        manifest.chainId !== config.CHAIN_ID ||
        manifest.releaseId !== config.CONTRACT_RELEASE_ID ||
        manifest.deploymentBlock !== config.CONTRACT_RELEASE_DEPLOYMENT_BLOCK
      ) {
        throw new Error('release binding mismatch');
      }
    } catch {
      // Paths, JSON parser diagnostics and file contents may contain secrets.
      throw new Error(
        'CONTRACT_RELEASE_MANIFEST_PATH: unreadable, malformed, unpinned or incompatible release',
      );
    }
  } else if (config.CONTRACT_RELEASE_ID || config.CONTRACT_RELEASE_SHA256) {
    throw new Error(
      'CONTRACT_RELEASE_MANIFEST_PATH: required when pinning a release',
    );
  }
  return Object.freeze({
    config,
    // Do not retain unrelated process secrets or bypass the schema via raw keys.
    environment: compatibilityEnvironment(config),
  });
}

let snapshot: RuntimeSnapshot | undefined;

/** Validate before loading AppModule or opening any database/RPC connection. */
export function initializeRuntimeConfig(): RuntimeSnapshot {
  if (!snapshot) {
    const files = ['.env.local', '.env']
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, 'utf8'));
    snapshot = createRuntimeSnapshot(process.env, files);
  }
  return snapshot;
}

export function getRuntimeConfig(): RuntimeConfig {
  return initializeRuntimeConfig().config;
}

export function getRuntimeEnvironment(): Environment {
  return initializeRuntimeConfig().environment;
}

/** Nest numeric consumers need numbers; boolean/string compatibility stays intact. */
export function getNestRuntimeConfig(): Readonly<
  Record<string, string | number | undefined>
> {
  const { config, environment } = initializeRuntimeConfig();
  const values: Record<string, string | number | undefined> = {
    ...environment,
  };
  for (const [key, definition] of Object.entries(runtimeSchema)) {
    const value = config[key as keyof RuntimeConfig];
    if (typeof value !== 'number') continue;
    for (const name of [key, ...((definition as Field<unknown>).aliases ?? [])])
      values[name] = value;
  }
  return Object.freeze(values);
}
