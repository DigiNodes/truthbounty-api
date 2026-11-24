import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { evaluateParity } from '../scripts/parity-report.mjs';

describe('Local, CI, and Container Type-Check Parity (PREWAVE-BE-030 / #625)', () => {
  const root = join(__dirname, '..');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  const tsconfigBuild = JSON.parse(
    readFileSync(join(root, 'tsconfig.build.json'), 'utf8'),
  );
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
  const ciWorkflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

  describe('1. Unified Source Set and TSConfig Parity', () => {
    it('declares unified source set including src and test in tsconfig.json', () => {
      expect(tsconfig.include).toBeDefined();
      expect(tsconfig.include).toContain('src/**/*');
      expect(tsconfig.include).toContain('test/**/*');
    });

    it('excludes build output, node_modules, and non-API contracts from tsconfig.json', () => {
      expect(tsconfig.exclude).toBeDefined();
      expect(tsconfig.exclude).toContain('node_modules');
      expect(tsconfig.exclude).toContain('dist');
      expect(tsconfig.exclude).toContain('contracts');
    });

    it('extends root tsconfig in tsconfig.build.json while isolating production emit', () => {
      expect(tsconfigBuild.extends).toBe('./tsconfig.json');
      expect(tsconfigBuild.include).toContain('src/**/*');
      expect(tsconfigBuild.exclude).toContain('test');
      expect(tsconfigBuild.exclude).toContain('**/*spec.ts');
    });

    it('enforces identical compiler options across build paths', () => {
      expect(tsconfig.compilerOptions.target).toBe('ES2023');
      expect(tsconfig.compilerOptions.strictNullChecks).toBe(true);
      expect(tsconfig.compilerOptions.module).toBe('commonjs');
    });
  });

  describe('2. Container Build and Source Exclusion Parity', () => {
    it('prevents container-only source exclusions by not ignoring test/ in .dockerignore', () => {
      const ignoredLines = dockerignore
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      expect(ignoredLines).not.toContain('test');
      expect(ignoredLines).not.toContain('test/**');
    });

    it('enforces type checking in Dockerfile so container cannot bypass type checks', () => {
      expect(dockerfile).toContain('RUN npm run type-check');
      expect(dockerfile).toContain('RUN npm run generate:prerequisites');
      expect(dockerfile).toContain('RUN npm run build');
    });

    it('preserves multi-stage isolation so test sources do not leak into final runner image', () => {
      const runnerStageIndex = dockerfile.indexOf('FROM node:20-alpine AS runner');
      expect(runnerStageIndex).toBeGreaterThan(-1);

      const runnerSection = dockerfile.slice(runnerStageIndex);
      expect(runnerSection).not.toContain('COPY --from=builder /app/test');
      expect(runnerSection).toContain('COPY --from=builder /app/dist ./dist');
      expect(runnerSection).toContain('COPY --from=builder /app/src/generated ./src/generated');
    });
  });

  describe('3. CI Gate and Prerequisite Parity', () => {
    it('runs explicit prerequisite generation, parity check, and type checking in CI', () => {
      expect(ciWorkflow).toContain('npm run generate:prerequisites');
      expect(ciWorkflow).toContain('npm run parity:check');
      expect(ciWorkflow).toContain('npm run type-check');
      expect(ciWorkflow).toContain('npm run build');
    });

    it('wires package.json lifecycle hooks so clean checkout local build runs type checking', () => {
      expect(packageJson.scripts['generate:prerequisites']).toBe('prisma generate');
      expect(packageJson.scripts['prebuild']).toContain('npm run generate:prerequisites');
      expect(packageJson.scripts['prebuild']).toContain('npm run type-check');
      expect(packageJson.scripts['pretype-check']).toBe('npm run generate:prerequisites');
      expect(packageJson.scripts['type-check']).toBe('tsc --noEmit');
    });
  });

  describe('4. Deliberately Broken Source Fixture Parity', () => {
    it('ensures any broken source fixture in src or test is within the compiler scope', () => {
      const testFixtureFile = 'test/fixtures/contracts/broken-source.fixture.ts';
      const srcFixtureFile = 'src/broken-fixture.ts';

      const isMatched = (file: string) => {
        return tsconfig.include.some((pattern: string) => {
          if (pattern === 'src/**/*' && file.startsWith('src/')) return true;
          if (pattern === 'test/**/*' && file.startsWith('test/')) return true;
          return false;
        });
      };

      expect(isMatched(testFixtureFile)).toBe(true);
      expect(isMatched(srcFixtureFile)).toBe(true);
    });
  });

  describe('5. Generated Prerequisites and Version Drift Diagnostics', () => {
    it('verifies generated client and schema existence in the repository baseline', () => {
      expect(existsSync(join(root, 'prisma', 'schema.prisma'))).toBe(true);
      expect(existsSync(join(root, 'src', 'generated', 'client', 'client.ts'))).toBe(true);
    });

    it('evaluates parity and provides structured sanitized report', () => {
      const report = evaluateParity();
      expect(report).toBeDefined();
      expect(report.checks).toBeDefined();
      expect(report.checks.typescript.expected).toBe('6.0.3');
      expect(report.checks.docker.dockerignoreClean).toBe(true);
      expect(report.checks.docker.dockerfileEnforced).toBe(true);
      expect(report.checks.tsconfig.ok).toBe(true);
      expect(report.checks.prerequisites.ok).toBe(true);
    });

    it('preserves strict diagnostics sanitization with no credential or secret exposure', () => {
      const report = evaluateParity();
      const reportString = JSON.stringify(report);

      const sensitiveTokens = ['password', 'secret', 'bearer', 'private_key', 'seed_phrase'];
      for (const token of sensitiveTokens) {
        expect(reportString.toLowerCase()).not.toContain(`"${token}"`);
      }
    });
  });
});
