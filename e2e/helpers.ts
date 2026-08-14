import { _electron as electron, type ElectronApplication } from '@playwright/test';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared Electron launch for the e2e specs.
 *
 * CI hardening: GitHub Actions runners execute as root inside a container,
 * where Chromium's SUID sandbox, GPU stack and /dev/shm behave differently
 * from a desktop. `--no-sandbox`, `--disable-gpu` and `--disable-dev-shm-usage`
 * are the standard flags for that environment and are applied only when
 * `process.env.CI` is set — local runs keep the full sandbox.
 */
export async function launchApp(): Promise<ElectronApplication> {
  const args = ['.vite/build/main.js'];
  if (process.env.CI) {
    args.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }
  const app = await electron.launch({ args });
  // Surface the app process's own output so a boot failure is diagnosable in
  // CI logs instead of a silent firstWindow timeout.
  const proc = app.process();
  proc.stdout?.on('data', (d) => console.log('[electron stdout]', String(d).trimEnd()));
  proc.stderr?.on('data', (d) => console.error('[electron stderr]', String(d).trimEnd()));
  proc.on('exit', (code) => console.error('[electron exit]', code));
  return app;
}

/**
 * Robust teardown: `app.close()` can hang when the app holds live PTYs (the
 * spawned shells keep the main process alive). Give close a short grace
 * period, then SIGKILL the process so the afterEach never eats the 60s test
 * timeout on CI.
 */
export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  try {
    await Promise.race([app.close(), sleep(5_000)]);
  } catch {
    /* close threw — force kill below */
  }
  try {
    if (app.process().exitCode === null) app.process().kill('SIGKILL');
  } catch {
    /* already gone */
  }
}
