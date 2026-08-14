import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsService } from './fsService';

describe('FsService', () => {
  let root: string;
  const svc = new FsService();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-fs-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('round-trips file contents', async () => {
    const f = path.join(root, 'note.txt');
    await svc.writeFile(f, 'hello');
    expect(await svc.readFile(f)).toBe('hello');
  });

  it('lists a directory folders-first, then alphabetically', async () => {
    await svc.create(path.join(root, 'zeta.txt'), false);
    await svc.create(path.join(root, 'alpha.txt'), false);
    await svc.create(path.join(root, 'sub'), true);
    const listing = await svc.readDir(root);
    expect(listing.error).toBeUndefined();
    expect(listing.entries.map((e) => e.name)).toEqual(['sub', 'alpha.txt', 'zeta.txt']);
  });

  it('degrades a failed listing to an error field instead of throwing', async () => {
    const listing = await svc.readDir(path.join(root, 'does-not-exist'));
    expect(listing.entries).toEqual([]);
    expect(listing.error).toBeTruthy();
  });

  it('creates, renames, stats and removes an entry', async () => {
    const a = await svc.create(path.join(root, 'a.txt'), false);
    expect(await svc.stat(a)).toMatchObject({ isDir: false, name: 'a.txt' });
    await svc.rename(a, path.join(root, 'b.txt'));
    expect(await svc.stat(a)).toBeNull();
    expect(await svc.stat(path.join(root, 'b.txt'))).not.toBeNull();
    await svc.remove(path.join(root, 'b.txt'));
    expect(await svc.stat(path.join(root, 'b.txt'))).toBeNull();
  });

  it('refuses to create over an existing file', async () => {
    const f = path.join(root, 'once.txt');
    await svc.create(f, false);
    await expect(svc.create(f, false)).rejects.toThrow();
  });

  it('finds files by name and content, skipping ignored dirs', async () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    await svc.writeFile(path.join(root, 'src', 'widget.ts'), 'export const answer = 42;\n');
    await svc.writeFile(path.join(root, 'node_modules', 'dep.ts'), 'const answer = 0;\n');
    const names = await svc.searchFiles(root);
    expect(names.some((p) => p.endsWith('widget.ts'))).toBe(true);
    expect(names.some((p) => p.includes('node_modules'))).toBe(false);
    const hits = await svc.grepFiles(root, 'answer');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 1 });
    expect(hits[0].path).toContain('widget.ts');
  });

  it('expands ~ to the home directory', async () => {
    const st = await svc.stat('~');
    expect(st).not.toBeNull();
    expect(st!.path).toBe(os.homedir());
  });

  it('rejects reading a missing file', async () => {
    await expect(svc.readFile(path.join(root, 'missing.txt'))).rejects.toThrow();
  });

  it('reads images as data URIs, guarding ext, size and readability', async () => {
    const png = path.join(root, 'img.png');
    await svc.writeFile(png, 'not-really-a-png');
    expect((await svc.readImage(png)).startsWith('data:image/png;base64,')).toBe(true);

    const jpg = path.join(root, 'pic.jpeg');
    await svc.writeFile(jpg, 'x');
    expect((await svc.readImage(jpg)).startsWith('data:image/jpeg;base64,')).toBe(true);

    // Unsupported extension → ''
    expect(await svc.readImage(path.join(root, 'notes.txt'))).toBe('');
    // Missing file → ''
    expect(await svc.readImage(path.join(root, 'missing.png'))).toBe('');
    // Over the 12 MB guard → ''
    const big = path.join(root, 'big.png');
    await fs.promises.writeFile(big, Buffer.alloc(12 * 1024 * 1024 + 1));
    expect(await svc.readImage(big)).toBe('');
  });

  it('degrades search to an empty result when the root is not a directory', async () => {
    const f = path.join(root, 'file.txt');
    await svc.writeFile(f, 'x');
    expect(await svc.searchFiles(f)).toEqual([]);
    expect(await svc.grepFiles(f, 'x')).toEqual([]);
  });

  it('returns [] for an empty grep query', async () => {
    expect(await svc.grepFiles(root, '')).toEqual([]);
  });

  it('skips binary and oversized files during grep', async () => {
    const bin = path.join(root, 'bin.dat');
    await fs.promises.writeFile(bin, Buffer.from([0, 1, 2, 3, 4]));
    const big = path.join(root, 'big.txt');
    await fs.promises.writeFile(big, 'target-word ' + 'x'.repeat(1024 * 1024));
    const hit = path.join(root, 'keep.txt');
    await svc.writeFile(hit, 'target-word');
    const hits = await svc.grepFiles(root, 'target-word');
    expect(hits.map((h) => h.path)).not.toContain(bin);
    expect(hits.map((h) => h.path)).not.toContain(big);
    expect(hits.map((h) => h.path)).toContain(hit);
  });

  it('caps search and grep results at the limit', async () => {
    await svc.writeFile(path.join(root, 'one.txt'), 'same-word');
    await svc.writeFile(path.join(root, 'two.txt'), 'same-word');
    expect(await svc.searchFiles(root, 1)).toHaveLength(1);
    expect(await svc.grepFiles(root, 'same-word', 1)).toHaveLength(1);
  });

  it('reports permission errors instead of throwing', async () => {
    const secret = path.join(root, 'secret');
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(secret, 'f.txt'), 'top secret');
    fs.chmodSync(secret, 0o000);
    try {
      const listing = await svc.readDir(secret);
      expect(listing.error).toBeTruthy();
      expect(listing.entries).toEqual([]);
      expect(await svc.stat(path.join(secret, 'f.txt'))).toBeNull();
      // Search traversals survive unreadable directories.
      expect(await svc.searchFiles(root)).toBeInstanceOf(Array);
      expect(await svc.grepFiles(root, 'secret')).toEqual([]);
    } finally {
      fs.chmodSync(secret, 0o755);
    }
  });

  it('follows symlinks when listing', async () => {
    const real = path.join(root, 'real-dir');
    fs.mkdirSync(real);
    const link = path.join(root, 'link-dir');
    fs.symlinkSync(real, link, 'dir');
    const listing = await svc.readDir(root);
    const entry = listing.entries.find((e) => e.name === 'link-dir');
    expect(entry).toBeDefined();
    expect(entry!.isDir).toBe(true);
  });

  it('creates parent directories on rename', async () => {
    const a = await svc.create(path.join(root, 'deep-src.txt'), false);
    await svc.rename(a, path.join(root, 'nested', 'deeper', 'moved.txt'));
    expect(await svc.stat(path.join(root, 'nested', 'deeper', 'moved.txt'))).not.toBeNull();
  });
});
