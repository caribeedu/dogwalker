import { test, expect } from '@playwright/test';
import { launchApp, closeApp } from './helpers';
import type { ElectronApplication } from '@playwright/test';

// Agent-created portal e2e: a terminal running `dogwalker portal new <url>` over
// the real broker materializes a portal (WebContentsView) as a canvas node.
// Run against the built app: `npm run package` then `npm run test:e2e`.
//
// The deeper portal CLI verbs (navigate/dom/type/click/js/screenshot) and linked
// sessions are covered by the portalCliTest Electron integration, since driving
// them needs CDP + reading terminal output (WebGL) that doesn't map to UI e2e.
let app: ElectronApplication;

test.afterEach(async () => {
  await closeApp(app);
});

test('a terminal can create a portal over the CLI', async () => {
  app = await launchApp();
  const page = await app.firstWindow();
  await expect(page.locator('.dw-rail')).toBeVisible({ timeout: 30_000 });

  // Spawn a plain shell terminal from the palette.
  await page.getByRole('button', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: 'Create terminal' }).click();
  const term = page.locator('.dw-term-body').first();
  await expect(term).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3000); // let the shell finish initializing

  // Drive the real `dogwalker` shim inside the terminal to create a portal.
  await term.click();
  await page.keyboard.type('dogwalker portal new "data:text/html,<h1>hi</h1>"');
  await page.keyboard.press('Enter');

  // The agent-created portal reconciles onto the canvas as a portal node.
  await expect(page.locator('.dw-portal').first()).toBeVisible({ timeout: 20_000 });
});
