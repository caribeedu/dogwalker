import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphStore } from './graphStore';
import { PtyManager } from './ptyManager';
import * as processTree from './processTree';

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

// ── safety net: the memory poller must never become an unhandled rejection
// source. listProcesses() normally resolves [] on error, but a rejection
// anywhere in checkMemory (e.g. a throwing process-tree implementation) must
// be logged by the interval's defensive catch — never leak.
describe('PtyManager memory poller safety net', () => {
  let dir = '';
  let graph: GraphStore;
  let ptys: PtyManager;
  let term = '';

  const webContents = {
    send: () => {},
    isDestroyed: () => false,
  } as unknown as ConstructorParameters<typeof PtyManager>[0];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-mem-'));
    graph = new GraphStore();
    ptys = new PtyManager(webContents, graph, { socketPath: dir, shimDir: dir });
    term = ptys.spawn({
      preset: 'shell', name: 'mem-term', stableId: 'mem-term',
      cols: 80, rows: 24, workspaceId: 'mem', floorName: 'ground', cwd: dir,
    }).id;
  });

  afterAll(async () => {
    ptys.killAll();
    await wait(200);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('logs instead of leaking a rejection when a memory poll fails', async () => {
    ptys.setMemoryLimit(term, 256); // starts the 5s poller
    const procSpy = vi.spyOn(processTree, 'listProcesses').mockRejectedValue(new Error('ps boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await wait(6_500); // one real poll cycle (5s interval)
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[dw] memory check failed'),
        expect.any(Error),
      );
    } finally {
      procSpy.mockRestore();
      errSpy.mockRestore();
      ptys.setMemoryLimit(term, 0); // stops the poller
    }
  }, 30_000);
});
