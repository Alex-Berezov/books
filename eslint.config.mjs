// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Flat config reads exclusions ONLY from here: a root .eslintignore is dead
    // weight under ESLint 9 and must not be reintroduced (see src/devops/eslint-ignores.spec.ts).
    ignores: [
      'eslint.config.mjs',
      'dist/**/*',
      // openapi-typescript output, regenerated in place by yarn openapi:types:from-schema
      'libs/api-client/src/types.ts',
    ],
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
      sourceType: 'commonjs',
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'off',
      // `return somePromise` inside `try` does not put the rejection anywhere the
      // `catch` can see it — the caller receives the rejected promise instead, so
      // the handler silently never runs. Cheaper than remembering to write await.
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    },
  },
  // Loosen rules for Prisma scripts where type-aware linting often misfires
  {
    files: ['prisma/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    files: ['src/**/*.dto.ts', 'src/**/dto/**/*.ts', 'src/shared/dto/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  // Loosen rules for spec files where Jest mock chaining triggers false positives
  {
    files: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  // Loosen unsafe rules for category service (new fields not yet in Prisma Client)
  {
    files: ['src/modules/category/category.service.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
