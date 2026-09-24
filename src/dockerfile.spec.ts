import { readFileSync } from 'fs';
import { join } from 'path';

describe('Docker build configuration', () => {
  const root = join(__dirname, '..');
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('uses node:20-alpine for both build and runtime stages', () => {
    expect(dockerfile).toContain('FROM node:20-alpine AS builder');
    expect(dockerfile).toContain('FROM node:20-alpine AS runner');
  });

  it('prunes development dependencies after build', () => {
    expect(dockerfile).toMatch(/npm prune --production/);
  });

  it('copies built dist artifacts and generated Prisma client into the final image', () => {
    expect(dockerfile).toContain('COPY --from=builder /app/dist ./dist');
    expect(dockerfile).toContain('COPY --from=builder /app/src/generated ./src/generated');
  });

  it('restricts Prisma engine binaries for Linux musl builds', () => {
    expect(schema).toContain('binaryTargets = ["native", "linux-musl"]');
  });

  it('declares a Node engine version constraint in package.json', () => {
    expect(packageJson.engines).toBeDefined();
    expect(packageJson.engines.node).toBe('>=20 <21');
  });
});
