import { listRepoFiles, readRepoFile } from './repo-files';

/**
 * STAB-DOC-BE-008: repository search regression test.
 * TruthBounty's production runtime authority is Optimism/EVM. Stellar is the
 * Drips program only. Any other mention of Stellar, Soroban or Freighter in
 * docs, examples, scripts or Swagger descriptions fails unless the same
 * paragraph is an explicit prohibition or refers to the Drips Wave program.
 */

const PROHIBITED = /\b(stellar|soroban|freighter)\b/i;
const NEGATION_OR_PROGRAM =
  /\b(no|not|never|without|non-goals?|out of scope|prohibit\w*|forbid\w*|reject\w*|exclude[sd]?|neither|nor|drips|wave)\b/i;

// Wave labelling automation and policy checks legitimately name the terms.
const ALLOWED_PREFIXES = ['.github/', 'test/docs/'];
const ALLOWED_FILES = new Set(['issue359.txt']);

const SWAGGER_LINE =
  /(description|summary)\s*:|\.setDescription|\.setTitle|@Api\w+\(/;

function isScannedFile(f: string): boolean {
  if (ALLOWED_FILES.has(f) || ALLOWED_PREFIXES.some((p) => f.startsWith(p)))
    return false;
  if (/(^|\/)(package-lock|pnpm-lock)\.json$|\.lock$/.test(f)) return false;
  if (/^(scripts|src\/scripts|examples)\//.test(f)) {
    return /\.(ts|js|mjs|sh|ps1|md|txt|ya?ml|json)$/i.test(f);
  }
  if (/^docs\/.*\.json$/.test(f)) return true;
  if (/(^|\/)\.env(\.|$)/.test(f)) return true;
  return /\.(md|txt|ya?ml)$/i.test(f);
}

function findViolations(
  file: string,
  text: string,
  lineFilter?: (line: string) => boolean,
): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!PROHIBITED.test(line)) return;
    if (lineFilter && !lineFilter(line)) return;
    let context = line;
    for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
      if (lines[j].trim() === '') break;
      context = `${lines[j]}\n${context}`;
    }
    if (NEGATION_OR_PROGRAM.test(context)) return;
    out.push(`${file}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe('prohibited production runtime claims (STAB-DOC-BE-008)', () => {
  const files = listRepoFiles();
  const scanned = files.filter(isScannedFile);

  it('scans a meaningful set of files', () => {
    expect(scanned.length).toBeGreaterThan(20);
  });

  it('has no Stellar/Soroban/Freighter runtime claims in docs, examples, scripts or config examples', () => {
    const violations = scanned.flatMap((f) =>
      findViolations(f, readRepoFile(f)),
    );
    expect(violations).toEqual([]);
  });

  it('has no such claims in Swagger descriptions', () => {
    const swaggerFiles = files.filter(
      (f) => /^src\/.*\.ts$/.test(f) && !/\.spec\.ts$/.test(f),
    );
    const violations = swaggerFiles.flatMap((f) =>
      findViolations(f, readRepoFile(f), (line) => SWAGGER_LINE.test(line)),
    );
    expect(violations).toEqual([]);
  });

  it('states Optimism/EVM and PostgreSQL/TypeORM as the runtime in the README', () => {
    const readme = readRepoFile('README.md');
    expect(readme).toMatch(/Optimism\/EVM/);
    expect(readme).toMatch(/PostgreSQL via TypeORM/);
    expect(readme).not.toMatch(/Stellar \(planned\)/i);
  });
});
