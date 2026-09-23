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
);