import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphStore } from './graphStore';
import { PtyManager } from './ptyManager';
import type { ProcInfo } from './processTree';
import type { DataBatch, SpawnOptions } from '../shared/ipc';

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

// ---- unit-level mocks ------------------------------------------------------
// checkMemory polls processTree.listProcesses/findOffender for the runaway
// guard. Those functions have their own tests (processTree.test.ts), so we
// inject deterministic fake rows here instead of shelling out to `ps`.
const { listProcessesMock, findOffenderMock } = vi.hoisted(() => ({
  listProcessesMock: vi.fn<() => Promise<ProcInfo[]>>(),
  findOffenderMock: vi.fn<() => { pid: number; totalMB: number } | null>(),
}));
vi.mock('./processTree', () => ({
  listProcesses: listProcessesMock,
  findOffender: findOffenderMock,
}));

type WebContentsLike = ConstructorParameters<typeof PtyManager>[0];

/** Recording stand-in for a renderer WebContents. */
function makeWebContents() {
  const sends: Array<[string, unknown]> = [];
  const wc = {
    destroyed: false,
    sends,
    send: (channel: string, payload: unknown) => {
      sends.push([channel, payload]);
    },
    isDestroyed: () => wc.destroyed,
  };
  return wc as { destroyed: boolean; sends: Array<[string, unknown]> } & WebContentsLike;
}

let wc: ReturnType<typeof makeWebContents>;
let graph: GraphStore;
let ptys: PtyManager;
let dir: string;

function freshManager(resolver?: (p: string) => string | null) {
  return new PtyManager(
    wc,
    graph,
    { socketPath: dir, shimDir: dir },
    resolver ?? ((_p) => null),
  );
}

function spawnShell(manager: PtyManager, extra: Partial<SpawnOptions> = {}) {
  return manager.spawn({
    preset: 'shell',
    name: 's',
    stableId: 's' + Math.random().toString(36).slice(2),
    cols: 80,
    rows: 24,
    workspaceId: 'ws',
    cwd: dir,
    ...extra,
  });
}

/** Poll `get()` until it includes `needle`; returns the last value read. */
async function waitForText(get: () => string, needle: string, timeoutMs = 4000, stepMs = 25): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = get();
  while (!text.includes(needle) && Date.now() < deadline) {
    await wait(stepMs);
    text = get();
  }
  return text;
}

/** Poll the recorded sends until a pty:data batch includes `needle`. */
async function waitForDataSend(needle: string, timeoutMs = 4000): Promise<DataBatch | null> {
  const deadline = Date.now() + timeoutMs;
  let batch: DataBatch | null = null;
  while (Date.now() < deadline) {
    const hit = wc.sends.find(
      ([ch, p]) => ch === 'pty:data' && (p as DataBatch).some(([, d]) => d.includes(needle)),
    );
    if (hit) {
      batch = hit[1] as DataBatch;
      break;
    }
    await wait(25);
  }
  return batch;
}

describe('PtyManager spawn & environment', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-spawn-'));
    wc = makeWebContents();
    graph = new GraphStore();
  });
  afterEach(async () => {
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('spawn registers a graph node and hands out sequential ids', async () => {
    ptys = freshManager();
    const a = spawnShell(ptys);
    const b = spawnShell(ptys);
    expect(a.id).toBe('t1');
    expect(b.id).toBe('t2');
    expect(graph.kindOf(a.id)).toBe('terminal');
    expect(graph.name(a.id)).toBe('s');
  });

  it('injects DOGWALKER_* env vars and puts the shim dir first on PATH', async () => {
    ptys = freshManager(
      (p) =>
        p === 'envtest' ? 'echo "ID=$DOGWALKER_TERMINAL_ID SOCK=$DOGWALKER_SOCKET PHEAD=${PATH%%:*}"' : null,
    );
    const { id } = ptys.spawn({
      preset: 'envtest',
      name: 's',
      stableId: 'env1',
      cols: 80,
      rows: 24,
      workspaceId: 'ws',
      cwd: dir,
    });
    const text = await waitForText(() => ptys.plainText(id), 'PHEAD=');
    // Fresh manager → the first terminal id is t1; socket and shim dir are the
    // env dir we passed; the first PATH segment must be the shim dir.
    expect(text).toContain('ID=t1');
    expect(text).toContain(`SOCK=${dir}`);
    expect(text).toContain(`PHEAD=${dir}`);
  });

  it('auto-runs a real preset command with the default resolver (claude)', async () => {
    // No 4th constructor arg → the real presetCommand resolver.
    ptys = new PtyManager(wc, graph, { socketPath: dir, shimDir: dir });
    const { id } = spawnShell(ptys, { preset: 'claude', stableId: 'c1' });
    // The auto-exec'd `claude` line shows up in the terminal (typed-command
    // echo at minimum, "command not found" if the CLI is absent).
    const text = await waitForText(() => ptys.plainText(id), 'claude', 5000);
    expect(text).toContain('claude');
  });

  it('falls back to the home dir when cwd is empty and defaults floor to ground', async () => {
    ptys = freshManager();
    const { id } = ptys.spawn({
      preset: 'shell',
      name: 's',
      stableId: 'nocwd',
      cols: 80,
      rows: 24,
      workspaceId: 'ws',
      cwd: '',
    });
    // The PTY itself starts in the home dir...
    ptys.write(id, 'pwd\r');
    const text = await waitForText(() => ptys.plainText(id), os.homedir());
    expect(text).toContain(os.homedir());
    // ...but the entry stores the raw spawn option (characterization: cwdOf
    // mirrors what was passed, not what the shell ended up in).
    expect(ptys.cwdOf(id)).toBe('');
    expect(ptys.floorOf(id)).toBe('ground');
    expect(ptys.presetOf(id)).toBe('shell');
    expect(ptys.isWalker(id)).toBe(false);
  });

  it('does not throw on a nonexistent cwd; the shell dies but the entry stays', async () => {
    ptys = freshManager();
    const before = wc.sends.length;
    let id = '';
    expect(() => {
      id = spawnShell(ptys, { stableId: 'badcwd', cwd: path.join(dir, 'nope') }).id;
    }).not.toThrow();
    // The entry is registered regardless; the child reports the chdir failure.
    expect(ptys.has(id)).toBe(true);
    await waitForText(() => ptys.plainText(id), 'chdir', 4000);
    // onExit fired: the renderer was told, the graph node is gone — but the
    // entry map is NOT auto-cleaned (kill() is the only remover).
    await wait(300);
    expect(wc.sends.slice(before).some(([ch]) => ch === 'pty:exit')).toBe(true);
    expect(graph.kindOf(id)).toBeNull();
    expect(ptys.has(id)).toBe(true);
    // kill() on the dead pty cleans the entry up without throwing.
    expect(() => ptys.kill(id)).not.toThrow();
    expect(ptys.has(id)).toBe(false);
  });

  it('spawning twice with the same stableId creates two distinct terminals', async () => {
    ptys = freshManager();
    const a = spawnShell(ptys, { stableId: 'dup' });
    const b = spawnShell(ptys, { stableId: 'dup' });
    expect(a.id).not.toBe(b.id);
    // findByStable returns the first live terminal with that stableId.
    expect(ptys.findByStable('dup')).toBe(a.id);
    expect(ptys.findByStable('missing')).toBeNull();
  });
});

describe('PtyManager write / resize / serialize / inject', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-io-'));
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
  });
  afterEach(async () => {
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('write delivers bytes to the PTY', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    ptys.write(id, 'echo WRITE_PROBE\r');
    const text = await waitForText(() => ptys.plainText(id), 'WRITE_PROBE');
    expect(text).toContain('WRITE_PROBE');
  });

  it('write to an unknown id is a silent no-op', () => {
    expect(() => ptys.write('nope', 'echo x\r')).not.toThrow();
  });

  it('resize updates the terminal size', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    ptys.resize(id, 100, 40);
    ptys.write(id, 'stty size\r');
    const text = await waitForText(() => ptys.plainText(id), '40 100');
    expect(text).toContain('40 100');
  });

  it('rejects tiny or unknown resizes', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    expect(() => ptys.resize(id, 1, 1)).not.toThrow();
    expect(() => ptys.resize('nope', 100, 40)).not.toThrow();
    // A real resize still works afterwards.
    ptys.resize(id, 100, 40);
    ptys.write(id, 'stty size\r');
    const text = await waitForText(() => ptys.plainText(id), '40 100');
    expect(text).toContain('40 100');
  });

  it('serialize returns the screen content; unknown ids serialize to empty', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    ptys.write(id, 'echo SERIALIZE_PROBE\r');
    await waitForText(() => ptys.plainText(id), 'SERIALIZE_PROBE');
    const serialized = ptys.serialize(id);
    expect(serialized).toContain('SERIALIZE_PROBE');
    expect(serialized).toContain('\x1b['); // ANSI escapes are preserved
    expect(ptys.serialize('nope')).toBe('');
  });

  it('plainText of an unknown id is empty', () => {
    expect(ptys.plainText('nope')).toBe('');
  });

  it('inject pastes into a bare shell immediately (no pending preset)', async () => {
    const { id } = spawnShell(ptys);
    // Inject synchronously, before the shell's bracketed-paste enable arrives,
    // so the mirror still reports DEC 2004 inactive → plain line, no wrap.
    expect(ptys.inject(id, 'echo INJECT_PROBE')).toBe(true);
    const text = await waitForText(() => ptys.plainText(id), 'INJECT_PROBE');
    expect(text).toContain('INJECT_PROBE');
    expect(ptys.inject('nope', 'echo x\r')).toBe(false);
  });
});

describe('PtyManager lifecycle: kill / killAll / killWorkspace', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-kill-'));
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
  });
  afterEach(async () => {
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('kill tears down the terminal: entry, graph node, process, renderer notice', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    expect(ptys.pidOf(id)).toBeTypeOf('number');
    const pid = ptys.pidOf(id) as number;
    expect(pid).toBeGreaterThan(0);
    ptys.kill(id);
    expect(ptys.has(id)).toBe(false);
    expect(ptys.pidOf(id)).toBeUndefined();
    expect(graph.kindOf(id)).toBeNull();
    // The renderer hears about the exit (async, right after the kill).
    let exitHeard = false;
    for (let i = 0; i < 40; i++) {
      if (wc.sends.some(([ch]) => ch === 'pty:exit')) {
        exitHeard = true;
        break;
      }
      await wait(50);
    }
    expect(exitHeard).toBe(true);
    // And the pty process is really gone (zombie reaped → ESRCH).
    let gone = false;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        gone = true;
        break;
      }
      await wait(50);
    }
    expect(gone).toBe(true);
  });

  it('kill of an unknown id is a no-op', () => {
    expect(() => ptys.kill('nope')).not.toThrow();
    expect(() => ptys.killAll()).not.toThrow();
  });

  it('killAll releases every terminal', () => {
    const a = spawnShell(ptys);
    const b = spawnShell(ptys);
    expect(ptys.has(a.id)).toBe(true);
    ptys.killAll();
    expect(ptys.has(a.id)).toBe(false);
    expect(ptys.has(b.id)).toBe(false);
    expect(ptys.pidOf(a.id)).toBeUndefined();
  });

  it('killWorkspace releases only that workspace\'s terminals', () => {
    const a = spawnShell(ptys, { workspaceId: 'wsA' });
    const b = spawnShell(ptys, { workspaceId: 'wsB' });
    ptys.killWorkspace('wsA');
    expect(ptys.has(a.id)).toBe(false);
    expect(ptys.has(b.id)).toBe(true);
  });

  it('killing a terminal before its preset auto-runs is safe', async () => {
    ptys = new PtyManager(
      wc,
      graph,
      { socketPath: dir, shimDir: dir },
      (p) => (p === 'agent' ? 'echo LATE_AUTOEXEC' : null),
    );
    const { id } = ptys.spawn({
      preset: 'agent',
      name: 's',
      stableId: 'earlykill',
      cols: 80,
      rows: 24,
      workspaceId: 'ws',
      cwd: dir,
    });
    ptys.kill(id);
    // The 600 ms autoexec fires with the entry gone → it must no-op silently.
    await wait(800);
    expect(ptys.has(id)).toBe(false);
    expect(wc.sends.filter(([ch]) => ch === 'pty:data').length).toBeLessThanOrEqual(1);
  });
});

describe('PtyManager accessors & renderer announcements', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-acc-'));
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
  });
  afterEach(async () => {
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('exposes the spawn options back through the accessors', () => {
    const { id } = ptys.spawn({
      preset: 'claude',
      name: 'lead',
      stableId: 'acc1',
      cols: 80,
      rows: 24,
      workspaceId: 'wsX',
      floorName: 'feature',
      walker: true,
      cwd: dir,
    });
    expect(ptys.nameOf(id)).toBe('lead');
    expect(ptys.workspaceOf(id)).toBe('wsX');
    expect(ptys.cwdOf(id)).toBe(dir);
    expect(ptys.presetOf(id)).toBe('claude');
    expect(ptys.floorOf(id)).toBe('feature');
    expect(ptys.isWalker(id)).toBe(true);
    ptys.setWalker(id, false);
    expect(ptys.isWalker(id)).toBe(false);
    // Unknown ids: empty strings / undefined / false.
    expect(ptys.nameOf('nope')).toBe('');
    expect(ptys.workspaceOf('nope')).toBe('');
    expect(ptys.cwdOf('nope')).toBe('');
    expect(ptys.floorOf('nope')).toBe('');
    expect(ptys.presetOf('nope')).toBeUndefined();
    expect(ptys.isWalker('nope')).toBe(false);
    expect(() => ptys.setWalker('nope', true)).not.toThrow();
  });

  it('announces recruit / dismiss / reassign to the renderer', () => {
    ptys.announceRecruit({
      id: 't9',
      stableId: 'recruit-1',
      name: 'rec',
      preset: 'claude',
      roleId: 'r1',
      walkerId: 't1',
      workspaceId: 'ws',
    });
    ptys.announceDismiss('t9');
    ptys.announceReassign('t9', 'renamed');
    expect(wc.sends).toContainEqual([
      'terminal:recruited',
      {
        id: 't9',
        stableId: 'recruit-1',
        name: 'rec',
        preset: 'claude',
        roleId: 'r1',
        walkerId: 't1',
        workspaceId: 'ws',
      },
    ]);
    expect(wc.sends).toContainEqual(['terminal:dismissed', 't9']);
    expect(wc.sends).toContainEqual(['terminal:reassigned', { id: 't9', name: 'renamed' }]);
  });

  it('skips renderer announcements while the target is destroyed', () => {
    wc.destroyed = true;
    ptys.announceRecruit({
      id: 't9',
      stableId: 'recruit-1',
      name: 'rec',
      preset: 'claude',
      walkerId: 't1',
      workspaceId: 'ws',
    });
    ptys.announceDismiss('t9');
    ptys.announceReassign('t9', 'renamed');
    expect(wc.sends).toHaveLength(0);
    wc.destroyed = false;
    ptys.announceDismiss('t9');
    expect(wc.sends).toEqual([['terminal:dismissed', 't9']]);
  });

  it('listForWorkspace returns the live terminals of one workspace only', () => {
    const a = spawnShell(ptys, { workspaceId: 'wsA', name: 'a', stableId: 'la1' });
    const b = spawnShell(ptys, { workspaceId: 'wsA', name: 'b', stableId: 'la2' });
    spawnShell(ptys, { workspaceId: 'wsB', name: 'c', stableId: 'lb1' });
    const list = ptys.listForWorkspace('wsA');
    expect(list).toHaveLength(2);
    expect(list).toEqual([
      { id: a.id, stableId: 'la1', name: 'a', preset: 'shell' },
      { id: b.id, stableId: 'la2', name: 'b', preset: 'shell' },
    ]);
    expect(ptys.listForWorkspace('wsZ')).toEqual([]);
  });
});

describe('PtyManager assignRole', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-role-'));
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
  });
  afterEach(async () => {
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('writes the role file under cwd/.dogwalker/roles and injects the prompt', async () => {
    const { id } = spawnShell(ptys, { stableId: 'roled' });
    await wait(300);
    const file = ptys.assignRole(id, { id: 'scout', name: 'Scout', instructions: 'Scout ahead.' });
    const expected = path.join(dir, '.dogwalker', 'roles', 'roled.md');
    expect(file).toBe(expected);
    expect(fs.readFileSync(expected, 'utf8')).toBe('# Scout\n\nScout ahead.');
    const text = await waitForText(() => ptys.plainText(id), 'Dogwalker role was updated');
    // The full prompt line wraps at 80 cols, so assert on its surviving parts.
    expect(text).toContain('Your Dogwalker role was updated');
    expect(text).toContain('roled.md before continuing');
  });

  it('returns empty for unknown ids or a null role', async () => {
    const { id } = spawnShell(ptys, { stableId: 'norole' });
    await wait(300);
    expect(ptys.assignRole('nope', { id: 'x', name: 'X', instructions: 'y' })).toBe('');
    expect(ptys.assignRole(id, null)).toBe('');
  });
});

// ---- attention: OSC 133 shell-integration marks + quiescence fallback ------
// Real bash readline swallows ESC bytes typed into the PTY input, so the OSC
// sequences are emitted by tiny scripts on disk (proven deterministic).
describe('PtyManager attention', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-att-'));
    fs.writeFileSync(path.join(dir, 'oscD.sh'), 'printf "\\x1b]133;D\\x07"\n');
    // Two D marks in ONE output burst: the second must be a no-op because
    // attention is already true (exercises the `attention === value` early
    // return without an intervening engage from a second write).
    fs.writeFileSync(path.join(dir, 'oscDD.sh'), 'printf "\\x1b]133;D\\x07\\x1b]133;D\\x07"\n');
    fs.writeFileSync(path.join(dir, 'oscC.sh'), 'printf "\\x1b]133;C\\x07"\n');
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
  });
  afterEach(async () => {
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('OSC 133 D flags attention and releases awaitQuiet; C clears it', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    const quiet = ptys.awaitQuiet(id, 5000);

    ptys.write(id, 'bash oscDD.sh\r');
    await waitForText(() => ptys.plainText(id), 'oscDD.sh');
    const truthy = await waitForText(() => JSON.stringify(wc.sends), '"pty:attention"', 4000);
    expect(truthy).toContain('"value":true');
    // Attention going true releases anyone awaiting quiet.
    await expect(Promise.race([quiet, wait(500).then(() => 'timeout')])).resolves.not.toBe('timeout');

    // Wait until every output chunk of the command has been flushed: a late
    // chunk's onOutput would clear attention and make the count below racy.
    await waitForDataSend('oscDD.sh');
    await wait(400);
    // The second D mark in the same burst found attention already true → no
    // duplicate event.
    const trueCount = wc.sends.filter(([ch, p]) => ch === 'pty:attention' && (p as { value: boolean }).value === true).length;
    expect(trueCount).toBe(1);

    // OSC 133 C marks a command start → engage → attention drops immediately.
    ptys.write(id, 'bash oscC.sh\r');
    await waitForText(() => JSON.stringify(wc.sends), '"value":false', 4000);
    await waitForDataSend('oscC.sh');
    ptys.killAll(); // stop the quiescence timer before it re-raises attention
    await wait(50);
    const falseCount = wc.sends.filter(([ch, p]) => ch === 'pty:attention' && (p as { value: boolean }).value === false).length;
    expect(falseCount).toBe(1);
  }, 15_000);

  it('awaitQuiet resolves immediately for unknown ids and releases every waiter on attention', async () => {
    await expect(ptys.awaitQuiet('nope', 5000)).resolves.toBeUndefined();
    const { id } = spawnShell(ptys);
    await wait(300);
    const q1 = ptys.awaitQuiet(id, 5000);
    const q2 = ptys.awaitQuiet(id, 5000);
    ptys.write(id, 'bash oscD.sh\r'); // D → attention true → releases both waiters
    await waitForText(() => JSON.stringify(wc.sends), '"value":true', 4000);
    await Promise.race([
      Promise.all([q1, q2]),
      wait(500).then(() => Promise.reject(new Error('waiters were never released'))),
    ]);
  });

  it('awaitQuiet resolves on timeout when the terminal never engages', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    // No input ever engages this terminal, so attention never raises: the
    // waiter must be released by its own timeout, not by quiescence.
    const started = Date.now();
    await ptys.awaitQuiet(id, 100);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it('writing input engages a terminal and suppresses attention sends when destroyed', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    ptys.write(id, 'bash oscD.sh\r');
    await waitForText(() => JSON.stringify(wc.sends), '"value":true', 4000);
    const trueCount = wc.sends.filter(([ch, p]) => ch === 'pty:attention' && (p as { value: boolean }).value === true).length;
    expect(trueCount).toBe(1);

    // Wait for all chunks of the D command to settle, then destroy the target.
    await waitForDataSend('oscD.sh');
    const baseline = wc.sends.length;
    wc.destroyed = true;
    // engage() flips attention to false, but the destroyed renderer must not
    // receive the clearing event (nor the flushed echo data).
    ptys.write(id, 'echo ENGAGED\r');
    await waitForText(() => ptys.plainText(id), 'ENGAGED');
    await wait(300);
    expect(wc.sends.slice(baseline)).toEqual([]);
    wc.destroyed = false;
  }, 12_000);
});

// ---- memory limits: runaway guard (processTree is mocked) ------------------
describe('PtyManager memory limits', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-mem-'));
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
    listProcessesMock.mockReset();
    findOffenderMock.mockReset();
    listProcessesMock.mockResolvedValue([]);
    findOffenderMock.mockReturnValue(null);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    ptys?.killAll(); // also stops the poller once no terminal has a limit
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('setMemoryLimit clamps negatives, tolerates unknown ids, and toggles the poller', async () => {
    const { id } = spawnShell(ptys, { memoryLimitMB: 5 }); // starts the poller
    expect(() => ptys.setMemoryLimit(id, -10)).not.toThrow(); // clamps to 0 → poller off
    expect(() => ptys.setMemoryLimit('nope', 10)).not.toThrow();
    ptys.setMemoryLimit(id, 20); // poller back on
    // checkMemory still works after the toggles.
    await (ptys as unknown as { checkMemory(): Promise<void> }).checkMemory();
    expect(listProcessesMock).toHaveBeenCalled();
  });

  it('checkMemory short-circuits when no terminal has a limit', async () => {
    spawnShell(ptys); // memoryLimitMB defaults to 0
    await (ptys as unknown as { checkMemory(): Promise<void> }).checkMemory();
    expect(listProcessesMock).not.toHaveBeenCalled();
    expect(findOffenderMock).not.toHaveBeenCalled();
  });

  it('checkMemory short-circuits when the process list is empty', async () => {
    const { id } = spawnShell(ptys, { memoryLimitMB: 10 });
    await (ptys as unknown as { checkMemory(): Promise<void> }).checkMemory();
    expect(listProcessesMock).toHaveBeenCalled();
    expect(findOffenderMock).not.toHaveBeenCalled();
    expect(ptys.has(id)).toBe(true);
  });

  it('spares the terminal when the tree is under the limit', async () => {
    const { id } = spawnShell(ptys, { memoryLimitMB: 10 });
    await wait(200);
    listProcessesMock.mockResolvedValue([{ pid: 1, ppid: 0, memory: 1024 }]);
    findOffenderMock.mockReturnValue(null);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await (ptys as unknown as { checkMemory(): Promise<void> }).checkMemory();
    expect(killSpy).not.toHaveBeenCalled();
    expect(ptys.plainText(id)).not.toContain('killed pid');
    expect(ptys.has(id)).toBe(true);
  });

  it('kills the heaviest offender, writes the reason, and keeps the shell alive', async () => {
    const { id } = spawnShell(ptys, { memoryLimitMB: 10 });
    await wait(200);
    listProcessesMock.mockResolvedValue([{ pid: 111, ppid: 1, memory: 1024 * 1024 }]);
    findOffenderMock.mockReturnValue({ pid: 111, totalMB: 500 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await (ptys as unknown as { checkMemory(): Promise<void> }).checkMemory();
    expect(killSpy).toHaveBeenCalledWith(111);
    // The message lands in the mirror (async) and in a flushed data batch.
    const text = await waitForText(() => ptys.plainText(id), 'killed pid 111');
    expect(text).toContain('500 MB over the 10 MB limit');
    const batch = await waitForDataSend('killed pid 111');
    expect(batch).not.toBeNull();
    // The shell itself is spared.
    expect(ptys.has(id)).toBe(true);
  });

  it('swallows process.kill errors (process already gone)', async () => {
    const { id } = spawnShell(ptys, { memoryLimitMB: 10 });
    await wait(200);
    listProcessesMock.mockResolvedValue([{ pid: 222, ppid: 1, memory: 1024 * 1024 }]);
    findOffenderMock.mockReturnValue({ pid: 222, totalMB: 999 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    await (ptys as unknown as { checkMemory(): Promise<void> }).checkMemory();
    expect(killSpy).toHaveBeenCalledTimes(1);
    await wait(100);
    expect(ptys.plainText(id)).not.toContain('killed pid');
    expect(ptys.has(id)).toBe(true);
  });
});

// ---- flush/pending edge branches -------------------------------------------
describe('PtyManager flush & pending bookkeeping', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pty-flush-'));
    wc = makeWebContents();
    graph = new GraphStore();
    ptys = freshManager();
  });
  afterEach(async () => {
    vi.useRealTimers();
    ptys?.killAll();
    await wait(100);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('drops pending data for a terminal killed before its flush fires', async () => {
    const { id } = spawnShell(ptys);
    await wait(300); // startup prompt already flushed
    vi.useFakeTimers();
    ptys.write(id, 'echo P1\r');
    // Let the echo arrive in small fake-time steps so the 16 ms flush timer
    // stays pending; the mirror showing P1 proves onData already ran.
    let seen = false;
    for (let i = 0; i < 200; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (ptys.plainText(id).includes('P1')) {
        seen = true;
        break;
      }
    }
    expect(seen).toBe(true);
    ptys.kill(id); // pending.delete → nothing left to flush
    await vi.advanceTimersByTimeAsync(40); // the scheduled flush fires, finds an empty map
    vi.useRealTimers();
    const hasP1 = wc.sends.some(
      ([ch, p]) => ch === 'pty:data' && (p as DataBatch).some(([, d]) => d.includes('P1')),
    );
    expect(hasP1).toBe(false);
  });

  it('a destroyed renderer skips the flush but keeps pending for the next one', async () => {
    const { id } = spawnShell(ptys);
    await wait(300);
    wc.destroyed = true;
    vi.useFakeTimers();
    ptys.write(id, 'echo DESTROY_PROBE\r');
    // Step the fake clock until the mirror shows the echo (proves onData ran
    // and the flush timer is armed); it fires while destroyed → early return,
    // pending retained.
    let seen1 = false;
    for (let i = 0; i < 300; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (ptys.plainText(id).includes('DESTROY_PROBE')) {
        seen1 = true;
        break;
      }
    }
    expect(seen1).toBe(true);
    await vi.advanceTimersByTimeAsync(40); // flush fires while destroyed
    wc.destroyed = false;
    ptys.write(id, 'echo AFTER_RESTORE\r');
    let seen2 = false;
    for (let i = 0; i < 300; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (ptys.plainText(id).includes('AFTER_RESTORE')) {
        seen2 = true;
        break;
      }
    }
    expect(seen2).toBe(true);
    await vi.advanceTimersByTimeAsync(40); // flush sends everything accumulated
    vi.useRealTimers();
    const probeSends = wc.sends
      .filter(([ch]) => ch === 'pty:data')
      .map(([, p]) => p as DataBatch)
      .filter((b) => b.some(([, d]) => d.includes('DESTROY_PROBE')));
    expect(probeSends.length).toBeGreaterThan(0);
    // The destroyed-window flush never leaked the chunk early: every batch that
    // carries DESTROY_PROBE also carries the later chunk.
    for (const batch of probeSends) {
      expect(batch.some(([, d]) => d.includes('AFTER_RESTORE'))).toBe(true);
    }
  });
});
