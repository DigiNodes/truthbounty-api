import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configurationArtifacts } from '../../scripts/generate-runtime-config';
import { Field, parseRuntimeConfig, runtimeSchema } from './runtime-schema';
import { parseEnvironmentFile } from './runtime-config';

describe('runtime configuration drift', () => {
  const root = resolve(__dirname, '../..');
  it('keeps the example and operator reference generated from the schema', () => {
    for (const [file, expected] of Object.entries(configurationArtifacts())) {
      expect(
        readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n'),
      ).toBe(expected);
    }
    expect(() =>
      parseRuntimeConfig(
        parseEnvironmentFile(readFileSync(join(root, '.env.example'), 'utf8')),
      ),
    ).not.toThrow();
  });
  it('has no overlapping canonical keys or aliases', () => {
    const names = Object.entries(runtimeSchema).flatMap(([key, definition]) => [
      key,
      ...((definition as Field<unknown>).aliases ?? []),
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
  it('requires all static runtime environment reads to have a schema entry', () => {
    const known = new Set(
      Object.entries(runtimeSchema).flatMap(([key, definition]) => [
        key,
        ...((definition as Field<unknown>).aliases ?? []),
      ]),
    );
    known.add('RELEASE_MANIFEST_MAX_AGE_MS'); // Derived milliseconds, never an independent input.
    const failures: string[] = [];
    function visit(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['generated', 'scripts', '__mocks__'].includes(entry.name))
          continue;
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(file);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts'))
          continue;
        const text = readFileSync(file, 'utf8');
        if (entry.name !== 'runtime-config.ts' && /process\.env\b/.test(text))
          failures.push(`${entry.name}: direct process.env read`);
        const matches = text.matchAll(
          /(?:(?:getRuntimeEnvironment\(\)|env)\.([A-Z][A-Z0-9_]+)|(?:\.get(?:<[^>]+>)?|read(?:PositiveInt|NonNegativeInt|Boolean))\(\s*(?:env,\s*)?['"]([A-Z][A-Z0-9_]+)['"])/g,
        );
        for (const match of matches)
          if (!known.has(match[1] ?? match[2]))
            failures.push(`${entry.name}: ${match[1] ?? match[2]}`);
      }
    }
    visit(join(root, 'src'));
    expect(failures).toEqual([]);
  });
});
