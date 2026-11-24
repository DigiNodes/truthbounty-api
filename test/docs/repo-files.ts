import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';

export const REPO_ROOT = resolve(__dirname, '..', '..');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'artifacts',
  'generated',
]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(REPO_ROOT, join(dir, entry.name)).split(sep).join('/'));
    }
  }
}

/** Tracked files (what a clean checkout contains); falls back to a directory walk. */
export function listRepoFiles(): string[] {
  try {
    const raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const files = raw.split('\0').filter(Boolean);
    if (files.length > 0) {
      return files.filter((f) => existsSync(join(REPO_ROOT, f)));
    }
  } catch {
    // not a git checkout: fall through to the directory walk
  }
  const out: string[] = [];
  walk(REPO_ROOT, out);
  return out;
}

export function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8').replace(/^\uFEFF/, '');
}
