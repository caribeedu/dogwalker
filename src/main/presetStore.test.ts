import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PresetStore, BUILTIN_PRESETS } from './presetStore';

describe('PresetStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-presets-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists every built-in preset out of the box', () => {
    const names = new PresetStore(dir).list().map((p) => p.name);
    for (const b of BUILTIN_PRESETS) expect(names).toContain(b.name);
  });

  it('creates and persists a custom preset', () => {
    new PresetStore(dir).create({ name: 'my-agent', icon: 'robot', command: 'my-agent --go' });
    const reopened = new PresetStore(dir).list();
    expect(reopened.find((p) => p.name === 'my-agent')?.command).toBe('my-agent --go');
  });

  it('deletes a built-in by hiding it, and the hide persists', () => {
    const store = new PresetStore(dir);
    expect(store.remove('claude')).toBe(true);
    expect(store.list().some((p) => p.id === 'claude')).toBe(false);
    expect(new PresetStore(dir).list().some((p) => p.id === 'claude')).toBe(false);
  });

  it('never deletes the last remaining preset', () => {
    const store = new PresetStore(dir);
    const builtinIds = BUILTIN_PRESETS.map((b) => b.id);
    // Hide all but the last built-in; the final removal must be refused.
    for (const id of builtinIds.slice(0, -1)) store.remove(id);
    expect(store.list()).toHaveLength(1);
    expect(store.remove(builtinIds[builtinIds.length - 1])).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it('get returns a built-in, a custom, and null for unknown ids', () => {
    const store = new PresetStore(dir);
    expect(store.get('shell')?.command).toBe('');
    const created = store.create({ name: 'custom-x', icon: 'star', command: 'custom-x run' });
    expect(store.get(created.id)).toMatchObject({ name: 'custom-x', command: 'custom-x run' });
    expect(store.get('does-not-exist')).toBeNull();
  });

  it('get returns copies, not internal references', () => {
    const store = new PresetStore(dir);
    const p = store.get('shell');
    p!.name = 'mutated';
    expect(store.get('shell')!.name).toBe('Shell');
  });

  it('create fills default name and icon when inputs are blank', () => {
    const p = new PresetStore(dir).create({ name: '   ', icon: '', command: 'x' });
    expect(p.name).toBe('Custom preset');
    expect(p.icon).toBe('sparkle');
  });

  it('update changes a custom preset and persists the change', () => {
    const store = new PresetStore(dir);
    const created = store.create({ name: 'old', icon: 'x', command: 'cmd' });
    const updated = store.update(created.id, { name: 'new', icon: 'y', command: 'cmd2' });
    expect(updated).toMatchObject({ id: created.id, name: 'new', icon: 'y', command: 'cmd2' });
    expect(new PresetStore(dir).get(created.id)).toMatchObject({ name: 'new', icon: 'y', command: 'cmd2' });
  });

  it('update returns null for an unknown id', () => {
    expect(new PresetStore(dir).update('nope', { name: 'a', icon: 'b', command: 'c' })).toBeNull();
  });

  it('update keeps existing values when input fields are blank', () => {
    const store = new PresetStore(dir);
    const created = store.create({ name: 'keep', icon: 'keep-icon', command: 'keep-cmd' });
    const updated = store.update(created.id, { name: '  ', icon: '', command: '  new-cmd  ' });
    expect(updated).toMatchObject({ name: 'keep', icon: 'keep-icon', command: 'new-cmd' });
  });

  it('remove deletes a custom preset and persists the deletion', () => {
    const store = new PresetStore(dir);
    const created = store.create({ name: 'doomed', icon: 'a', command: 'b' });
    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeNull();
    expect(new PresetStore(dir).get(created.id)).toBeNull();
  });

  it('remove returns false for an unknown id', () => {
    expect(new PresetStore(dir).remove('no-such-preset')).toBe(false);
  });

  it('remove returns false for an already-hidden builtin', () => {
    const store = new PresetStore(dir);
    expect(store.remove('claude')).toBe(true);
    expect(store.remove('claude')).toBe(false);
  });

  it('loads the legacy bare-array format, dropping invalid entries', () => {
    fs.writeFileSync(
      path.join(dir, 'presets.json'),
      JSON.stringify([
        { id: 'a', name: 'A', icon: 'i', command: 'a-cmd' },
        { id: 'b', name: 'B', command: 'b-cmd' },
        { id: 'c', name: 42, command: 'x' },
        null,
        'garbage',
      ]),
    );
    const ids = new PresetStore(dir).list().map((p) => p.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('c');
  });

  it('loads hiddenBuiltins from a legacy object file and filters non-strings', () => {
    fs.writeFileSync(
      path.join(dir, 'presets.json'),
      JSON.stringify({ custom: [], hiddenBuiltins: ['codex', 42, null, 'opencode'] }),
    );
    const ids = new PresetStore(dir).list().map((p) => p.id);
    expect(ids).not.toContain('codex');
    expect(ids).not.toContain('opencode');
    expect(ids).toContain('claude');
  });

  it('treats a malformed presets file as a fresh install', () => {
    fs.writeFileSync(path.join(dir, 'presets.json'), '{not json');
    expect(new PresetStore(dir).list()).toHaveLength(BUILTIN_PRESETS.length);
  });

  it('ignores a non-object, non-array presets file', () => {
    fs.writeFileSync(path.join(dir, 'presets.json'), JSON.stringify('just a string'));
    expect(new PresetStore(dir).list()).toHaveLength(BUILTIN_PRESETS.length);
  });

  it('handles a legacy object file with non-array custom and hiddenBuiltins fields', () => {
    fs.writeFileSync(path.join(dir, 'presets.json'), JSON.stringify({ custom: 'oops', hiddenBuiltins: 'oops' }));
    expect(new PresetStore(dir).list()).toHaveLength(BUILTIN_PRESETS.length);
  });
});
