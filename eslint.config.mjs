// Flat ESLint config (v0.8). Lean on purpose: `tsc --noEmit` (npm run typecheck)
// is the real correctness gate, so lint here catches only clear mistakes and
// stays quiet on the intentional patterns in this codebase (empty best-effort
// catches, control chars in ANSI/CDP strings, deliberate `any` at IPC edges).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      '.vite/**',
      'dist/**',
      'node_modules/**',
      'forge.config.ts',
      'vite.*.config.ts',
      'eslint.config.mjs',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    // React hooks linting for the renderer (the `react-hooks/exhaustive-deps`
    // disable directives in Canvas etc. need the rule to be defined).
    files: ['src/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // The CLI shim is a plain-node ESM script (no bundler, no TS globals).
    files: ['src/shim/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
);
