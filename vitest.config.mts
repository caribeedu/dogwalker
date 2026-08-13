import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Unit + component tests run on Vitest (shares the project's Vite pipeline).
 * Two projects: main-process code in a node environment, renderer code in jsdom
 * with Testing Library. End-to-end tests that drive the real Electron app live
 * under `e2e/` and run on Playwright instead (`npm run test:e2e`).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Main-process modules import 'electron' at load; swap in a node stub.
      electron: fileURLToPath(new URL('./src/test/electron.mock.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.ts',
        'src/preload.ts',
        'src/renderer.tsx',
        'src/vite-env.d.ts',
        'src/test/**',
        '**/*.test.{ts,tsx}',
        '**/e2e/**',
        // Integration harness (DW_PORTALCLI / DW_PORTALLINK): drives a real
        // socket + PTY + browser against the running app. Not unit-testable;
        // excluded so the gate doesn't punish un-reachable code.
        'src/main/portalIntegration.ts',
      ],
      thresholds: {
        // Ratcheting: thresholds sit just below the last measured baseline and
        // only ever move up as coverage improves.
        // 2026-08-13 baseline #1: statements 28.5 / branches 24.4 / funcs 25.3 / lines 29.1.
        // 2026-08-13 after Onda 1 (7 stores/managers tested): stmts 33.2 / br 27.9 / fn 29.3 / ln 34.2.
        // 2026-08-13 after Ondas 2+3 (broker 100%, presets, workspaceStore, renderer): stmts 44.6 / br 42.5 / fn 39.0 / ln 45.7.
        // 2026-08-13 after Ondas 4-6 (e2e CI, icons/Panel/Composer/TerminalPalette,
        // presetStore/skillInstall/fsService/gitService/ptyManager): stmts 51.2 / br 49.6 / fn 48.3 / ln 51.7.
        statements: 48,
        branches: 46,
        functions: 45,
        lines: 48,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/app/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
