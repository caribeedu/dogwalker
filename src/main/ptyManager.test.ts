import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphStore } from './graphStore';
import { PtyManager } from './ptyManager';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── integration: a real PTY, exercising the spawn → auto-run preset → role
// sequencing (v1.3.2). When a terminal is created with BOTH a preset command
// and a role, the agent must start FIRST and read its role AFTER — never the
// reverse (role landing in the bare shell before the agent boots).
describe('PtyManager spawn-time role ordering', () => {
  let dir = '';
  let graph: GraphStore;
  let ptys: PtyManager;

  const webContents = {
    send: () => {},
    isDestroyed: () => false,
  } as unknown as ConstructorParameters<typeof PtyManager>[0];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-'));
    graph = new GraphStore();
    // Custom resolver so the "agent" preset is a cheap, deterministic marker
    // instead of launching a real coding agent.
    ptys = new PtyManager(webContents, graph, { socketPath: dir, shimDir: dir }, (p) =>
      p === 'agent' ? 'echo __PRESET_STARTED__' : null,
    );
  });

  afterAll(async () => {
    ptys.killAll();
    // The just-killed PTY children briefly keep the temp dir locked on Windows;
    // retry, and don't fail the suite on a stubborn handle.
    await wait(200);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('injects the role only after the preset command has run', async () => {
    const { id } = ptys.spawn({
      preset: 'agent',
      name: 'lead',
      stableId: 'lead',
      cols: 80,
      rows: 24,
      workspaceId: 'ws',
      floorName: 'ground',
      cwd: dir,
    });

    // Mirror the renderer's spawn path: assign the role immediately, while the
    // preset command is still queued to auto-run.
    ptys.assignRole(id, { id: 'scout', name: 'Scout', instructions: 'Scout ahead.' });

    // The role prompt must be deferred, not injected into the bare shell yet.
    expect(ptys.plainText(id)).not.toContain('Dogwalker role was updated');

    // Give the preset auto-exec + boot-quiescence + injection time to complete.
    let text = '';
    for (let i = 0; i < 40; i++) {
      text = ptys.plainText(id);
      if (text.includes('Dogwalker role was updated') && text.includes('__PRESET_STARTED__')) break;
      await wait(250);
    }

    const presetAt = text.indexOf('__PRESET_STARTED__');
    const roleAt = text.indexOf('Dogwalker role was updated');
    expect(presetAt).toBeGreaterThanOrEqual(0);
    expect(roleAt).toBeGreaterThanOrEqual(0);
    // The whole point of the fix: preset first, role second.
    expect(presetAt).toBeLessThan(roleAt);
  }, 20_000);

  it('injects immediately when the terminal has no pending preset command', async () => {
    const { id } = ptys.spawn({
      preset: 'shell', // resolver returns null → nothing auto-runs
      name: 'plain',
      stableId: 'plain',
      cols: 80,
      rows: 24,
      workspaceId: 'ws',
      floorName: 'ground',
      cwd: dir,
    });
    await wait(50);
    ptys.assignRole(id, { id: 'sentry', name: 'Sentry', instructions: 'Stand guard.' });
    // No preset to wait for, so the role goes in right away (runtime reassign path).
    let text = '';
    for (let i = 0; i < 12; i++) {
      text = ptys.plainText(id);
      if (text.includes('Dogwalker role was updated')) break;
      await wait(100);
    }
    expect(text).toContain('Dogwalker role was updated');
  }, 10_000);
});

describe('PtyManager quit vs destroyed WebContents', () => {
  it('killAll does not throw or send when the renderer is already gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-quit-'));
    const graph = new GraphStore();
    let destroyed = false;
    const sent: string[] = [];
    const webContents = {
      send: (channel: string) => {
        if (destroyed) throw new Error('Object has been destroyed');
        sent.push(channel);
      },
      isDestroyed: () => destroyed,
    } as unknown as ConstructorParameters<typeof PtyManager>[0];

    const ptys = new PtyManager(webContents, graph, { socketPath: dir, shimDir: dir });
    ptys.spawn({
      preset: 'shell',
      name: 't',
      stableId: 't',
      cols: 80,
      rows: 24,
      workspaceId: 'ws',
      floorName: 'ground',
      cwd: dir,
    });
    await wait(100);
    // Mimic BrowserWindow `closed`: contents die, then main kills PTYs.
    destroyed = true;
    expect(() => ptys.killAll()).not.toThrow();
    await wait(300);
    expect(sent.filter((c) => c === 'pty:exit')).toHaveLength(0);

    await wait(100);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }, 10_000);
});
