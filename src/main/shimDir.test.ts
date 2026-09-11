import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { createShimDir } from './shimDir';

describe('createShimDir', () => {
  let userData: string;
  let appPath: string;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-shim-ud-'));
    appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-shim-app-'));
    // The app layout createShimDir expects: <appPath>/src/shim/shim.mjs.
    fs.mkdirSync(path.join(appPath, 'src', 'shim'), { recursive: true });
    fs.writeFileSync(
      path.join(appPath, 'src', 'shim', 'shim.mjs'),
      '#!/usr/bin/env node\n// placeholder shim — content is not inspected by createShimDir\n',
    );
    vi.spyOn(app, 'getPath').mockReturnValue(userData);
    vi.spyOn(app, 'getAppPath').mockReturnValue(appPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(appPath, { recursive: true, force: true });
  });

  it('creates <userData>/shim and copies shim.mjs from the app path into it', () => {
    const dir = createShimDir();
    expect(dir).toBe(path.join(userData, 'shim'));
    const copied = fs.readFileSync(path.join(dir, 'shim.mjs'), 'utf8');
    expect(copied).toContain('#!/usr/bin/env node');
    expect(copied).toContain('placeholder shim');
  });

  it('writes posix dogwalker/walk wrappers invoking node, chmod 0o755', () => {
    const dir = createShimDir();
    for (const name of ['dogwalker', 'walk']) {
      const p = path.join(dir, name);
      const content = fs.readFileSync(p, 'utf8');
      expect(content).toContain('exec node');
      expect(content).toContain(`"${path.join(dir, 'shim.mjs')}"`);
      expect(fs.statSync(p).mode & 0o777).toBe(0o755);
    }
  });

  it('is idempotent: a second call reuses the same dir and keeps the wrappers', () => {
    const first = createShimDir();
    const second = createShimDir();
    expect(second).toBe(first);
    expect(fs.existsSync(path.join(second, 'shim.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(second, 'dogwalker'))).toBe(true);
    expect(fs.existsSync(path.join(second, 'walk'))).toBe(true);
  });
});
