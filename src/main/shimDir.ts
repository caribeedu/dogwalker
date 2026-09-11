import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

/**
 * Materializes the shim directory that gets prepended to every terminal's PATH
 * (ARCHITECTURE.md §3, §5.1). Contains the shim script plus `dogwalker` and
 * `walk` wrappers that invoke it under the system `node`. Because it is only on
 * the PATH of Dogwalker-spawned terminals, the CLI "exists only inside the
 * canvas".
 */

/** Resolve the shipped shim.mjs (dev tree, packaged asar, or extraResource). */
export function resolveShimSource(): string {
  const candidates = [
    // Dev (`electron-forge start`) and packaged asar after packageAfterCopy.
    path.join(app.getAppPath(), 'src', 'shim', 'shim.mjs'),
  ];
  // Electron sets resourcesPath in a real app; unit tests may leave it undefined.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'shim', 'shim.mjs'));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // asar edge cases: treat as missing and try the next candidate
    }
  }
  throw new Error(
    'dogwalker shim.mjs not found. Looked in:\n' + candidates.join('\n'),
  );
}

/**
 * Copy a file that may live inside an asar.
 *
 * `fs.copyFileSync` is unreliable with asar sources: on some Electron builds it
 * hangs with no throw, which leaves the BrowserWindow on a black screen because
 * createWindow never reaches loadURL. read + write goes through the patched
 * asar-aware fs paths and always completes or throws.
 */
export function copyOutOfAsar(src: string, dest: string): void {
  fs.writeFileSync(dest, fs.readFileSync(src));
}

export function createShimDir(): string {
  const dir = path.join(app.getPath('userData'), 'shim');
  fs.mkdirSync(dir, { recursive: true });

  const shimSrc = resolveShimSource();
  const shimDest = path.join(dir, 'shim.mjs');
  copyOutOfAsar(shimSrc, shimDest);

  if (process.platform === 'win32') {
    const cmd = `@echo off\r\nnode "${shimDest}" %*\r\n`;
    fs.writeFileSync(path.join(dir, 'dogwalker.cmd'), cmd);
    fs.writeFileSync(path.join(dir, 'walk.cmd'), cmd);
  } else {
    const sh = `#!/bin/sh\nexec node "${shimDest}" "$@"\n`;
    for (const name of ['dogwalker', 'walk']) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, sh);
      fs.chmodSync(p, 0o755);
    }
  }
  return dir;
}
