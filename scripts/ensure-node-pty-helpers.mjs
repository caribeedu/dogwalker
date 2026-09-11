/**
 * node-pty's prebuild `spawn-helper` often lands mode 644 after npm install.
 * Without +x, every PTY spawn fails with `posix_spawnp failed`.
 * Idempotent — safe from postinstall and again at app boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export function ensureNodePtyHelpersExecutable(log = console.warn) {
  let ptyRoot;
  try {
    ptyRoot = path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    return;
  }

  const helpers = [];
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
      log(`dogwalker: chmod +x ${path.relative(ptyRoot, helper) || helper}`);
    } catch (err) {
      log(`dogwalker: could not chmod ${helper}: ${err.message}`);
    }
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  ensureNodePtyHelpersExecutable();
}
