import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphStore } from './graphStore';
import { PtyManager } from './ptyManager';
import { RoutineService } from './routineService';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RoutineService.steps', () => {
  it('splits on && and newlines into ordered steps', () => {
    expect(RoutineService.steps('a && b\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('RoutineService (integration, real PTY)', () => {
  let dir: string;
  let ptys: PtyManager;
  let routines: RoutineService;
  let term = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-routine-'));
    const graph = new GraphStore();
    const webContents = { send: () => {}, isDestroyed: () => false } as unknown as ConstructorParameters<typeof PtyManager>[0];
    ptys = new PtyManager(webContents, graph, { socketPath: 'unused', shimDir: dir });
    routines = new RoutineService(dir, ptys, () => {});
    term = ptys.spawn({ preset: 'shell', cols: 80, rows: 24, workspaceId: 'rt', stableId: 'rt-term', cwd: '', name: 'agent' }).id;
    await wait(3000);
  }, 30_000);

  afterAll(() => {
    ptys?.kill(term);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs a &&-chained routine in order and returns to idle', async () => {
    const routine = routines.create('rt', {
      name: 'chain',
      targetStableId: 'rt-term',
      prompt: 'echo ROUTINE_STEP1 && echo ROUTINE_STEP2',
      intervalMs: 3_600_000, // never on its own; we drive it with runNow
    });
    await routines.runNow(routine.id);
    const screen = ptys.serialize(term);
    const i1 = screen.indexOf('ROUTINE_STEP1');
    const i2 = screen.indexOf('ROUTINE_STEP2');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(routines.list('rt')[0]?.status).toBe('idle');
    routines.remove(routine.id);
  }, 30_000);

  it('pauses a routine and skips a run whose target is gone', async () => {
    const routine = routines.create('rt', {
      name: 'guarded', targetStableId: 'rt-term', prompt: 'echo X', intervalMs: 3_600_000,
    });
    const paused = routines.setEnabled(routine.id, false);
    expect(paused).toMatchObject({ status: 'paused', enabled: false });

    ptys.kill(term);
    await wait(300);
    await expect(routines.runNow(routine.id)).resolves.toBeUndefined();
    expect(routines.list('rt').find((r) => r.id === routine.id)?.status).toBe('paused');
    routines.remove(routine.id);
  }, 30_000);

  it('logs instead of leaking a rejection when a tick throws before its internal try', async () => {
    // onUpdate fires before tick's internal try; a throw there rejects the
    // tick. The interval's defensive catch must log it, never surface an
    // unhandled rejection (which vitest would fail the suite on).
    const boomTerm = ptys.spawn({ preset: 'shell', cols: 80, rows: 24, workspaceId: 'rt', stableId: 'boom-term', cwd: '', name: 'boom-term' }).id;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = new RoutineService(dir, ptys, () => { throw new Error('onUpdate boom'); });
    try {
      const routine = throwing.create('rt', {
        name: 'boom', targetStableId: 'boom-term', prompt: 'echo X', intervalMs: 5_000,
      });
      await wait(6_500); // one real interval cycle (5s min)
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[dw] routine ${routine.id} tick failed`),
        expect.any(Error),
      );
    } finally {
      throwing.disposeAll();
      ptys.kill(boomTerm);
      errSpy.mockRestore();
    }
  }, 30_000);
});
