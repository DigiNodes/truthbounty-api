// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      ecmaVersion: 5,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn'
    },
  },
  {
    // Type-aware rules require precise types, which test doubles (jest.fn(),
    // supertest bodies, fixture casts) intentionally do not have. Follow the
    // typescript-eslint documented pattern: disable the type-checked rule
    // subset for test files only. All base rules, style, and prettier still
    // apply to these files, and src/** keeps the full strict gate.
    files: ['**/*.spec.ts', 'test/**/*.ts', 'scripts/**/*.ts', 'examples/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // V2-BE-111: Enforce the TypeORM-only persistence boundary.
    //
    // TypeORM/PostgreSQL is the one persistence path for new backend code.
    // Prisma already has real, load-bearing usage in the files listed in
    // the override below (auth, notifications, outbox, sybil-resistance,
    // analytics, ai-assistant, identity/worldcoin), this rule does not
    // touch that existing usage, it only stops it from spreading further.
    // Migrating those files off Prisma is a separate, much larger change
    // and out of scope here.
    files: ['src/**/*.ts'],
    ignores: ['src/generated/**', 'src/prisma/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@prisma/client',
              message:
                'New code must use TypeORM, not Prisma. If this file is one of the pre-existing Prisma-backed modules, add it to the override in eslint.config.mjs rather than suppressing this inline.',
            },
          ],
          patterns: [
            {
              group: ['**/prisma/prisma.service', '**/generated/client*'],
              message:
                'New code must use TypeORM, not Prisma. If this file is one of the pre-existing Prisma-backed modules, add it to the override in eslint.config.mjs rather than suppressing this inline.',
            },
          ],
        },
      ],
    },
  },
  {
    // Grandfathered: real, currently load-bearing Prisma usage that
    // predates this rule. Do not add files here for new work; this list
    // should only shrink as these modules are migrated to TypeORM.
    files: [
      'src/prisma/prisma.module.ts',
      'src/prisma/prisma.service.ts',
      'src/auth/auth.service.ts',
      'src/notifications/services/notifications.service.ts',
      'src/outbox/outbox.service.ts',
      'src/sybil-resistance/sybil-resistance.service.ts',
      'src/analytics/analytics.service.ts',
      'src/ai-assistant/ai-assistant.service.ts',
      'src/ai-assistant/rag.service.ts',
      'src/ai-assistant/services/ai-assistant.service.ts',
      'src/ai-assistant/services/rag.service.ts',
      'src/identity/identity.service.ts',
      'src/identity/worldcoin/worldcoin.service.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);