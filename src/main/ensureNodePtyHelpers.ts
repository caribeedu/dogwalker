import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * node-pty's prebuild `spawn-helper` often lands mode 644 after npm install.
 * Without +x, every PTY spawn fails with `posix_spawnp failed`.
 * Idempotent — safe from postinstall and again at app boot.
 */
export function ensureNodePtyHelpersExecutable(): void {
  // Bundled main is CJS; createRequire(__filename) resolves node-pty from the
  // app's node_modules (packaged or dev).
  const require = createRequire(__filename);
  let ptyRoot: string;
  try {
    ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return;
  }

  const helpers: string[] = [];
  const prebuilds = path.join(ptyRoot, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const plat of fs.readdirSync(prebuilds)) {
      helpers.push(path.join(prebuilds, plat, 'spawn-helper'));
    }
  }
  helpers.push(path.join(ptyRoot, 'build', 'Release', 'spawn-helper'));

  for (const helper of helpers) {
    if (!fs.existsSync(helper)) continue;
    try {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0) continue;
      fs.chmodSync(helper, 0o755);
    } catch {
      // best-effort; spawn will surface a clear error if it still fails
    }
  }
}
