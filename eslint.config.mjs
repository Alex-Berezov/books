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
      'libs/api-client/dist/**/*',
      'libs/api-client/examples/**/*',
      'dist/**/*',
      // openapi-typescript output: committed at src/types.ts, regenerated at types.ts
      'libs/api-client/src/types.ts',
      'libs/api-client/types.ts',
      // Hand-written Node script that no lint can actually read. tsconfig.eslint.json
      // includes scripts/**/* while allowJs is off, so type-aware ESLint cannot put a
      // .js file in the program. Measured 26.08.2026: without this line
      // `eslint scripts/generate-openapi-schema.js` exits 1 with
      // `Parsing error: "parserOptions.project" ... file was not found`; with it, exit 0.
      // lint-staged reaches the file through its *.{ts,tsx,js} glob, so the failure
      // would land on every commit touching it. The four rule-suppression directives in
      // its header are already dead for the same reason — see LEGACY-281.
      'scripts/generate-openapi-schema.js',
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
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
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
  // Loosen rules for libs (API client) where type-aware linting often misfires
  {
    files: ['libs/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
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
