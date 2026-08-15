import { test, expect } from '@playwright/test';
import { launchApp, closeApp } from './helpers';
import type { ElectronApplication } from '@playwright/test';

// Smoke E2E: the real app boots and paints its shell. This is the pattern the
// richer scenarios (broker `ask`/`contract`, Walker teams, floors, portals)
// migrate onto from the old in-app harnesses — each drives the built Electron
// app end to end instead of poking internals.
let app: ElectronApplication;

test.afterEach(async () => {
  await closeApp(app);
});

test('the app boots and paints its shell', async () => {
  app = await launchApp();
  const window = await app.firstWindow();
  await expect(window.locator('.dw-rail')).toBeVisible({ timeout: 30_000 });
});
