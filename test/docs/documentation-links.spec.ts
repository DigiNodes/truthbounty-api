import { posix } from 'path';
import { listRepoFiles, readRepoFile } from './repo-files';

/**
 * STAB-DOC-BE-008: documentation link check.
 * Relative links must resolve to a tracked file or directory. External URLs
 * are not fetched, so this test is deterministic and works offline.
 */

const files = listRepoFiles();
const known = new Set<string>(files);
for (const f of files) {
  let dir = posix.dirname(f);
  while (dir !== '.' && !known.has(dir)) {
    known.add(dir);
    dir = posix.dirname(dir);
  }
}
const markdown = files.filter((f) => /\.md$/i.test(f));

function stripFencedCode(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

function stripInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, '');
}

function extractTargets(text: string): string[] {
  const body = stripInlineCode(stripFencedCode(text));
  const targets: string[] = [];
  const patterns = [
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    /^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gm,
    /\b(?:href|src)=["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

function isCheckable(target: string): boolean {
  if (target.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//'))
    return false;
  if (/[<>{}$*]/.test(target)) return false; // placeholders and globs
  return true;
}

function resolveTarget(fromFile: string, target: string): string {
  const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
  const joined = clean.startsWith('/')
    ? clean.slice(1)
    : posix.join(posix.dirname(fromFile), clean);
  return posix.normalize(joined).replace(/\/$/, '');
}

describe('documentation links (STAB-DOC-BE-008)', () => {
  it('finds markdown files to check', () => {
    expect(markdown.length).toBeGreaterThan(10);
  });

  it('has no broken relative markdown links', () => {
    const broken: string[] = [];
    for (const file of markdown) {
      for (const target of extractTargets(readRepoFile(file))) {
        if (!isCheckable(target)) continue;
        const resolved = resolveTarget(file, target);
        if (resolved === '' || resolved.startsWith('..')) {
          if (resolved !== '')
            broken.push(`${file}: ${target} (escapes repository)`);
          continue;
        }
        if (!known.has(resolved)) broken.push(`${file}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('has no references to missing documentation files in inline code', () => {
    const missing: string[] = [];
    for (const file of markdown) {
      const body = stripFencedCode(readRepoFile(file));
      for (const match of body.matchAll(/`([A-Za-z0-9_./-]+\.md)`/g)) {
        const name = match[1];
        const pathLike =
          name.includes('/') || /^[A-Z][A-Z0-9_]+\.md$/.test(name);
        if (!pathLike) continue;
        const candidates = [
          posix.normalize(posix.join(posix.dirname(file), name)),
          posix.normalize(name),
          posix.normalize(posix.join('docs', name)),
        ];
        if (!candidates.some((c) => known.has(c)))
          missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
