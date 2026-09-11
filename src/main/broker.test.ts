import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Contract } from '../shared/ipc';
import { execFile } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractJsonObjects, Broker } from './broker';
import { GraphStore } from './graphStore';
import { History } from './history';
import { ContractStore } from './contractStore';
import { PresetStore } from './presetStore';
import { RoleStore } from './roleStore';
import { WorkspaceStore } from './workspaceStore';
import { PtyManager } from './ptyManager';
import type { NoteStore } from './noteStore';
import type { PortalManager } from './portalManager';
import type { BrokerRequest, BrokerResponse } from '../shared/protocol';

// ── unit: the contract loop relies on pulling the peer's JSON answer out of a
// noisy terminal capture that may also contain the injected schema's braces.
describe('extractJsonObjects', () => {
  it('returns every top-level JSON object in order', () => {
    expect(extractJsonObjects('noise {"a":1} more {"b":2} end')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it('skips brace runs that are not valid JSON', () => {
    expect(extractJsonObjects('a {not json} b {"ok":true} c')).toEqual([{ ok: true }]);
  });
  it('treats a nested object as one top-level object', () => {
    expect(extractJsonObjects('x {"a":{"b":1}} y')).toEqual([{ a: { b: 1 } }]);
  });
  it('is unfazed by braces inside strings', () => {
    expect(extractJsonObjects('{"s":"a } b {"}')).toEqual([{ s: 'a } b {' }]);
  });
  it('returns nothing when there is no JSON object', () => {
    expect(extractJsonObjects('just some prose, no objects here')).toEqual([]);
  });
  it('handles escaped quotes and backslashes inside strings', () => {
    expect(extractJsonObjects('{"s":"a \\"quoted\\" \\\\ path"}')).toEqual([{ s: 'a "quoted" \\ path' }]);
  });
  it('ignores an object whose braces never close', () => {
    expect(extractJsonObjects('{"a":1')).toEqual([]);
    expect(extractJsonObjects('{')).toEqual([]);
  });
  it('skips a brace run whose content does not parse, even with a valid object inside', () => {
    expect(extractJsonObjects('{ {"a":1} }')).toEqual([]);
  });
  it('keeps scanning after an unbalanced opener', () => {
    expect(extractJsonObjects('} {"ok":1} {')).toEqual([{ ok: 1 }]);
  });
  it('extracts an empty object', () => {
    expect(extractJsonObjects('{}')).toEqual([{}]);
  });
  it('ignores non-object JSON such as arrays and scalars', () => {
    expect(extractJsonObjects('[1,2] "str" 42 null true')).toEqual([]);
  });
});

// ── integration: the real broker over a real socket, driving real PTYs, exactly
// as the CLI shim would (this replaces the DW_BROKERTEST and DW_WALKERTEST
// harnesses). The shim shell-PATH round-trip is left to an e2e test.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rpc(socketPath: string, req: BrokerRequest): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      resolve(JSON.parse(buffer.slice(0, nl)) as BrokerResponse);
      socket.end();
    });
    socket.on('error', reject);
  });
}

/** Same as rpc, but sends a raw line (used for the malformed-request path). */
function rawRpc(socketPath: string, text: string): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('connect', () => socket.write(text + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      resolve(JSON.parse(buffer.slice(0, nl)) as BrokerResponse);
      socket.end();
    });
    socket.on('error', reject);
  });
}

describe('Broker (integration, real PTYs)', () => {
  let dir: string;
  let sock: string;
  let broker: Broker;
  let ptys: PtyManager;
  let graph: GraphStore;
  let lead = '';
  let reviewer = '';
  let tester = '';
  let boss = '';
  let grunt = '';

  const stub = <T>() => ({}) as unknown as T;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-broker-'));
    sock = process.platform === 'win32'
      ? `\\\\.\\pipe\\dogwalker-test-${Math.random().toString(36).slice(2)}`
      : path.join(dir, 'broker.sock');
    graph = new GraphStore();
    const history = new History(path.join(dir, 'history'));
    const contracts = new ContractStore(dir);
    contracts.create({
      name: 'verdict',
      schema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string' } } },
      maxAttempts: 2,
      timeoutMs: 3_000,
      rejectionPrompt: 'echo RETRY_PLEASE',
      fallback: { decision: 'FALLBACK' },
    });
    const presets = new PresetStore(dir);
    const roles = new RoleStore(dir);
    roles.create({ name: 'scout', instructions: 'Scout ahead.' });
    roles.create({ name: 'sentry', instructions: 'Stand guard.' });
    const workspaces = new WorkspaceStore(dir);
    const webContents = { send: () => {}, isDestroyed: () => false } as unknown as ConstructorParameters<typeof PtyManager>[0];
    ptys = new PtyManager(webContents, graph, { socketPath: sock, shimDir: dir });
    broker = new Broker(sock, graph, ptys, history, stub(), stub(), workspaces, presets, roles, contracts);
    broker.listen();
    await wait(500);

    const base = { preset: 'shell' as const, cols: 80, rows: 24, workspaceId: 'test', cwd: '' };
    lead = ptys.spawn({ ...base, name: 'lead', stableId: 'lead' }).id;
    reviewer = ptys.spawn({ ...base, name: 'reviewer', stableId: 'reviewer' }).id;
    tester = ptys.spawn({ ...base, name: 'tester', stableId: 'tester' }).id;
    boss = ptys.spawn({ ...base, name: 'boss', stableId: 'boss', walker: true, cwd: dir }).id;
    grunt = ptys.spawn({ ...base, name: 'grunt', stableId: 'grunt' }).id;
    graph.connect(lead, reviewer);
    graph.connect(lead, tester);
    await wait(3000); // let the shells finish initializing
  }, 30_000);

  afterAll(() => {
    for (const id of [lead, reviewer, tester, boss, grunt]) ptys?.kill(id);
    broker?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers a message and returns the peer’s captured output', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: lead, target: 'reviewer', body: 'echo ASK_OK' });
    expect(res.ok).toBe(true);
    expect((res.data as { body?: string }).body).toContain('ASK_OK');
  }, 30_000);

  it('lists only the terminals the caller is wired to', async () => {
    const res = await rpc(sock, { cmd: 'list', from: lead });
    const names = (res.data as { peers?: Array<{ name: string }> }).peers?.map((p) => p.name) ?? [];
    expect(names.sort()).toEqual(['reviewer', 'tester']);
  }, 30_000);

  it('denies an ask from an unwired terminal', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: 'nope', target: 'reviewer', body: 'hi' });
    expect(res.ok).toBe(false);
  }, 30_000);

  it('fans out an ask to every connected terminal', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: lead, all: true, body: 'echo TEAM_OK' });
    const results = (res.data as { results?: Array<{ ok: boolean; body?: string }> }).results ?? [];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && r.body?.includes('TEAM_OK'))).toBe(true);
  }, 30_000);

  it('validates a contract answer and returns just the value', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: lead, target: 'reviewer', body: 'echo {"decision":"approve"}', contract: 'verdict' });
    expect(res.ok).toBe(true);
    expect((res.data as { decision?: string }).decision).toBe('approve');
  }, 30_000);

  it('returns the fallback when the peer never satisfies the contract', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: lead, target: 'reviewer', body: 'echo {"decision":7}', contract: 'verdict' });
    expect(res.ok).toBe(true);
    expect((res.data as { decision?: string }).decision).toBe('FALLBACK');
  }, 30_000);

  it('lets a Walker recruit, reassign and dismiss a teammate', async () => {
    const rec = await rpc(sock, { cmd: 'recruit', from: boss, agent: 'shell', role: 'scout' });
    expect(rec.ok).toBe(true);
    const recId = (rec.data as { id?: string }).id ?? '';
    expect(recId).toBeTruthy();
    expect(graph.areConnected(boss, recId)).toBe(true);
    expect(graph.name(recId)).toBe('scout');

    const assigned = await rpc(sock, { cmd: 'assign', from: boss, target: 'scout', role: 'sentry' });
    expect(assigned.ok).toBe(true);
    expect(graph.name(recId)).toBe('sentry');

    const dis = await rpc(sock, { cmd: 'dismiss', from: boss, target: 'sentry' });
    await wait(400);
    expect(dis.ok).toBe(true);
    expect(ptys.has(recId)).toBe(false);
    expect(graph.kindOf(recId)).toBeNull();
  }, 30_000);

  it('denies Walker verbs from a non-Walker terminal', async () => {
    const res = await rpc(sock, { cmd: 'recruit', from: grunt, agent: 'shell', role: 'scout' });
    expect(res.ok).toBe(false);
  }, 30_000);

  it('lists a peer’s floor and reaches it across the floor boundary', async () => {
    const cfLead = ptys.spawn({ preset: 'shell', cols: 80, rows: 24, cwd: '', name: 'cf-lead', stableId: 'cf-lead', workspaceId: 'cf-ws', floorName: 'ground' }).id;
    const cfWorker = ptys.spawn({ preset: 'shell', cols: 80, rows: 24, cwd: '', name: 'cf-worker', stableId: 'cf-worker', workspaceId: 'cf-floor', floorName: 'featX' }).id;
    graph.connect(cfLead, cfWorker);
    await wait(3000);
    const listRes = await rpc(sock, { cmd: 'list', from: cfLead });
    const peers = (listRes.data as { peers?: Array<{ name: string; floor?: string }> }).peers ?? [];
    expect(peers).toContainEqual(expect.objectContaining({ name: 'cf-worker', floor: 'featX' }));
    const askRes = await rpc(sock, { cmd: 'ask', from: cfLead, target: 'cf-worker', body: 'echo CROSSFLOOR_OK' });
    expect(askRes.ok).toBe(true);
    expect((askRes.data as { body?: string }).body).toContain('CROSSFLOOR_OK');
    ptys.kill(cfLead);
    ptys.kill(cfWorker);
  }, 30_000);

  it('fails fast (not hang) when the target terminal has died', async () => {
    const victim = ptys.spawn({ preset: 'shell', cols: 80, rows: 24, workspaceId: 'test', cwd: '', name: 'victim', stableId: 'victim' }).id;
    graph.connect(lead, victim);
    ptys.kill(victim);
    await wait(600); // let onExit drop its graph node
    const t0 = Date.now();
    const res = await rpc(sock, { cmd: 'ask', from: lead, target: 'victim', body: 'echo hi' });
    expect(res.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000); // instant, not the ask timeout
  }, 30_000);

  // The real CLI shim round-trip: `--json` is universal, so any verb prints a
  // machine-readable { ok, data } envelope; without it the output is plain text.
  it('the shim emits a JSON envelope for any verb with --json', async () => {
    const shim = path.join(process.cwd(), 'src', 'shim', 'shim.mjs');
    const env = { ...process.env, DOGWALKER_SOCKET: sock, DOGWALKER_TERMINAL_ID: lead };
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve, reject) =>
        execFile(process.execPath, [shim, ...args], { env }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        ),
      );

    const parsed = JSON.parse(await run(['list', '--json'])) as { ok: boolean; data: { peers: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.data.peers)).toBe(true);

    // Plain (no --json) output is human text, not a JSON envelope.
    const plain = await run(['list']);
    expect(() => JSON.parse(plain)).toThrow();
  }, 15_000);
});

// ── unit: same wire protocol, but stub deps so every dispatch path runs in
// isolation (no real PTYs, no shells). Authorization is still the connection
// graph; private handlers are reached through a real socket like the shim does.
describe('Broker (unit, stub deps)', () => {
  let dir: string;
  let seq = 0;
  let sock = '';
  let broker: Broker;
  let graph: GraphStore;
  let contracts: ContractStore;
  let noteContent: Map<string, string>;
  let portalIds: Set<string>;
  let history: { append: ReturnType<typeof vi.fn> };
  let notes: {
    read: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
  let portals: {
    create: ReturnType<typeof vi.fn>;
    notifyCreated: ReturnType<typeof vi.fn>;
    has: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    click: ReturnType<typeof vi.fn>;
    type: ReturnType<typeof vi.fn>;
    scroll: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    js: ReturnType<typeof vi.fn>;
    dom: ReturnType<typeof vi.fn>;
    consoleLog: ReturnType<typeof vi.fn>;
  };
  let workspaces: { resolveFloorTarget: ReturnType<typeof vi.fn> };
  let presets: { get: ReturnType<typeof vi.fn> };
  let roles: { list: ReturnType<typeof vi.fn> };
  const terminals = new Set<string>();
  const walkers = new Set<string>();
  const answers = new Map<string, string>();
  const captured = new Map<string, string>();
  const injected: Array<{ to: string; body: string }> = [];
  const awaited: Array<{ to: string; timeoutMs: number }> = [];
  const slowTargets = new Set<string>();
  const failingTargets = new Set<string>();
  const rolloverTargets = new Set<string>();
  const spawned: Array<Record<string, unknown>> = [];
  const killed: string[] = [];

  function ptysStub(): PtyManager {
    return {
      has: (id: string) => terminals.has(id),
      isWalker: (id: string) => walkers.has(id),
      plainText: (id: string) => captured.get(id) ?? '',
      inject: (id: string, body: string) => { injected.push({ to: id, body }); return true; },
      // Simulate the peer producing its answer during the quiet-wait: the
      // capture is cumulative scrollback, so the broker's before/after delta
      // isolates just the new output — exactly like the real PTY mirror.
      awaitQuiet: async (id: string, timeoutMs: number) => {
        awaited.push({ to: id, timeoutMs });
        // A peer whose quiet-wait explodes: the exchange throws mid-ask, so
        // handleAsk's Promise.all rejects — the dispatch catch must answer.
        if (failingTargets.has(id)) throw new Error('exchange exploded');
        if (slowTargets.has(id)) await new Promise((r) => setTimeout(r, 400));
        const answer = answers.get(id);
        if (answer) captured.set(id, (captured.get(id) ?? '') + answer);
        // Scrollback rolled over: the capture now starts mid-history, so the
        // broker's before/after delta cannot be computed and it must fall back
        // to returning the whole (truncated) screen.
        if (rolloverTargets.has(id)) captured.set(id, captured.get(id)!.slice(-3));
      },
      serialize: () => 'SCREEN_CONTENT',
      floorOf: (id: string) => (id === 'floorPeer' ? 'featX' : 'ground'),
      workspaceOf: () => 'ws1',
      cwdOf: () => '/tmp/cwd',
      spawn: (opts: { name?: string }) => {
        const id = `recruit-${spawned.length + 1}`;
        spawned.push(opts);
        graph.addNode(id, opts.name ?? 'recruit', 'terminal');
        terminals.add(id);
        return { id };
      },
      kill: (id: string) => { killed.push(id); },
      assignRole: (_id: string, role: { name: string }) => `/roles/${role.name}`,
      announceRecruit: () => {},
      announceDismiss: () => {},
      announceReassign: () => {},
    } as unknown as PtyManager;
  }

  const addTerminal = (id: string, name: string): void => {
    graph.addNode(id, name, 'terminal');
    terminals.add(id);
    graph.connect('lead', id);
  };

  const addNote = (id: string, name: string, content: string): void => {
    graph.addNode(id, name, 'note');
    noteContent.set(id, content);
    graph.connect('lead', id);
  };

  const addPortal = (id: string, name: string): void => {
    graph.addNode(id, name, 'portal');
    portalIds.add(id);
    graph.connect('lead', id);
  };

  const addVerdict = (overrides: Partial<Omit<Contract, 'id'>> = {}): Contract =>
    contracts.create({
      name: 'verdict',
      schema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string' } } },
      maxAttempts: 2,
      timeoutMs: 3_000,
      rejectionPrompt: 'RETRY_PROMPT',
      fallback: { decision: 'FALLBACK' },
      ...overrides,
    } as Omit<Contract, 'id'>);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-broker-unit-'));
  });

  beforeEach(async () => {
    graph = new GraphStore();
    noteContent = new Map();
    portalIds = new Set();
    terminals.clear();
    walkers.clear();
    answers.clear();
    captured.clear();
    slowTargets.clear();
    failingTargets.clear();
    rolloverTargets.clear();
    injected.length = 0;
    awaited.length = 0;
    spawned.length = 0;
    killed.length = 0;
    graph.addNode('lead', 'Lead', 'terminal');
    terminals.add('lead');
    history = { append: vi.fn() };
    notes = {
      read: vi.fn((id: string) => noteContent.get(id) ?? ''),
      append: vi.fn((id: string, text: string) => noteContent.set(id, (noteContent.get(id) ?? '') + text)),
      write: vi.fn((id: string, text: string) => noteContent.set(id, text)),
    };
    portals = {
      create: vi.fn((id: string) => void portalIds.add(id)),
      notifyCreated: vi.fn(),
      has: vi.fn((id: string) => portalIds.has(id)),
      navigate: vi.fn(),
      click: vi.fn(async () => ({ clicked: true })),
      type: vi.fn(async () => ({ typed: true })),
      scroll: vi.fn(async () => ({ scrolled: true })),
      screenshot: vi.fn(async () => '/tmp/shot.png'),
      js: vi.fn(async () => 42),
      dom: vi.fn(async () => '<div>hi</div>'),
      consoleLog: vi.fn(() => 'console line'),
    };
    workspaces = {
      resolveFloorTarget: vi.fn((_layer: string, floor: string) =>
        floor === 'featX' ? { layerId: 'layer-fx', cwd: '/tmp/fx' } : null),
    };
    presets = { get: vi.fn((id: string) => (id === 'shell' ? { id: 'shell' } : null)) };
    roles = { list: vi.fn(() => [{ id: 'r-scout', name: 'scout', instructions: 'Scout ahead.' }]) };
    // ContractStore persists to contracts.json in `dir`; reset it so each test
    // starts from an empty store regardless of what earlier tests created.
    fs.rmSync(path.join(dir, 'contracts.json'), { force: true });
    contracts = new ContractStore(dir);

    sock = process.platform === 'win32'
      ? `\\\\.\\pipe\\dogwalker-unit-${seq++}-${Math.random().toString(36).slice(2)}`
      : path.join(dir, `unit-${seq++}.sock`);
    broker = new Broker(
      sock,
      graph,
      ptysStub(),
      history as unknown as History,
      notes as unknown as NoteStore,
      portals as unknown as PortalManager,
      workspaces as unknown as WorkspaceStore,
      presets as unknown as PresetStore,
      roles as unknown as RoleStore,
      contracts,
    );
    broker.listen();
    await wait(100);
  });

  afterEach(() => {
    broker?.close();
    fs.rmSync(sock, { force: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── protocol level: dispatch errors ────────────────────────────────
  it('rejects a malformed request line', async () => {
    const res = await rawRpc(sock, 'this is not json at all');
    expect(res).toEqual({ ok: false, error: 'malformed request' });
  });

  it('rejects a request with no or unknown caller', async () => {
    const noFrom = await rpc(sock, { cmd: 'list' } as unknown as BrokerRequest);
    expect(noFrom).toEqual({ ok: false, error: 'unknown caller' });
    const ghost = await rpc(sock, { cmd: 'list', from: 'ghost' });
    expect(ghost).toEqual({ ok: false, error: 'unknown caller' });
  });

  it('rejects an unknown command', async () => {
    const res = await rpc(sock, { cmd: 'frobnicate', from: 'lead' } as unknown as BrokerRequest);
    expect(res).toEqual({ ok: false, error: 'unknown command' });
  });

  // ── ask: capture, broadcast and timeout clamp ──────────────────────
  it('returns the peer capture for a single ask', async () => {
    addTerminal('peer1', 'Peer One');
    answers.set('peer1', 'hello world');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'Peer One', body: 'hi' });
    expect(res.ok).toBe(true);
    expect((res.data as { body?: string }).body).toBe('hello world');
  });

  it('clamps an ask timeout below the 1s floor up to 1s', async () => {
    addTerminal('peer1', 'Peer One');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'x', timeoutMs: 50 });
    expect(res.ok).toBe(true);
    expect(awaited).toEqual([{ to: 'peer1', timeoutMs: 1_000 }]);
  });

  it('clamps an ask timeout above the 1h ceiling down to 1h', async () => {
    addTerminal('peer1', 'Peer One');
    await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'x', timeoutMs: 9_999_999_999 });
    expect(awaited[0].timeoutMs).toBe(3_600_000);
  });

  it('uses the 180s default when no ask timeout is given', async () => {
    addTerminal('peer1', 'Peer One');
    await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'x' });
    expect(awaited[0].timeoutMs).toBe(180_000);
  });

  it('asks nothing when there is no target and all is unset', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', body: 'x' });
    expect(res).toEqual({ ok: false, error: 'ask needs a terminal target' });
  });

  it('answers the socket when an ask explodes mid-exchange', async () => {
    // The exchange throws for this peer, so handleAsk's internal Promise.all
    // rejects; the dispatch catch must answer the socket instead of leaking
    // an unhandled rejection.
    addTerminal('peer1', 'Peer One');
    failingTargets.add('peer1');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'Peer One', body: 'hi' });
    expect(res).toEqual({ ok: false, error: 'exchange exploded' });
  });

  it('broadcasts to explicit targets with a broadcast id', async () => {
    addTerminal('peer1', 'Peer One');
    addTerminal('peer2', 'Peer Two');
    answers.set('peer1', 'A');
    answers.set('peer2', 'B');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', targets: ['peer1', 'peer2'], body: 'x' });
    expect(res.ok).toBe(true);
    const data = res.data as { broadcastId?: string; results?: Array<{ name: string; body?: string }> };
    expect(data.broadcastId).toBeTruthy();
    expect(data.results?.map((r) => r.name).sort()).toEqual(['Peer One', 'Peer Two']);
  });

  it('team ask --all skips excluded peers by id and by name', async () => {
    addTerminal('peer1', 'Peer One');
    addTerminal('peer2', 'Peer Two');
    answers.set('peer1', 'A');
    answers.set('peer2', 'B');
    const byId = await rpc(sock, { cmd: 'ask', from: 'lead', all: true, body: 'x', exclude: ['peer1'] });
    const names1 = ((byId.data as { results?: Array<{ name: string }> }).results ?? []).map((r) => r.name);
    expect(names1).toEqual(['Peer Two']);
    const byName = await rpc(sock, { cmd: 'ask', from: 'lead', all: true, body: 'x', exclude: ['Peer One'] });
    const names2 = ((byName.data as { results?: Array<{ name: string }> }).results ?? []).map((r) => r.name);
    expect(names2).toEqual(['Peer Two']);
  });

  it('team ask --all with no connected terminals errors', async () => {
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', all: true, body: 'x' });
    expect(res).toEqual({ ok: false, error: 'no connected terminals to ask' });
  });

  // ── check ──────────────────────────────────────────────────────────
  it('check returns the serialized screen and logs it', async () => {
    addTerminal('peer1', 'Peer One');
    const res = await rpc(sock, { cmd: 'check', from: 'lead', target: 'peer1' });
    expect(res).toEqual({ ok: true, data: { screen: 'SCREEN_CONTENT' } });
    expect(history.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'check', from: 'lead', to: 'peer1' }));
  });

  it('check on an unwired terminal errors', async () => {
    const res = await rpc(sock, { cmd: 'check', from: 'lead', target: 'peer1' });
    expect(res).toEqual({ ok: false, error: 'no connected terminal named "peer1"' });
  });

  // ── connect / disconnect ───────────────────────────────────────────
  it('connect wires the caller to a named terminal', async () => {
    graph.addNode('peer1', 'Peer One', 'terminal');
    terminals.add('peer1');
    const res = await rpc(sock, { cmd: 'connect', from: 'lead', target: 'Peer One' });
    expect(res).toEqual({ ok: true });
    expect(graph.areConnected('lead', 'peer1')).toBe(true);
  });

  it('connect refuses to wire the caller to itself or to an unknown node', async () => {
    const self = await rpc(sock, { cmd: 'connect', from: 'lead', target: 'lead' });
    expect(self).toEqual({ ok: false, error: 'no such terminal' });
    const unknown = await rpc(sock, { cmd: 'connect', from: 'lead', target: 'ghost' });
    expect(unknown).toEqual({ ok: false, error: 'no such terminal' });
  });

  it('disconnect unwires an existing leash', async () => {
    addTerminal('peer1', 'Peer One');
    const res = await rpc(sock, { cmd: 'disconnect', from: 'lead', target: 'Peer One' });
    expect(res).toEqual({ ok: true });
    expect(graph.areConnected('lead', 'peer1')).toBe(false);
  });

  it('disconnect from an unwired terminal errors', async () => {
    const res = await rpc(sock, { cmd: 'disconnect', from: 'lead', target: 'peer1' });
    expect(res).toEqual({ ok: false, error: 'not connected' });
  });

  // ── note verbs ─────────────────────────────────────────────────────
  it('note read returns the connected note content', async () => {
    addNote('n1', 'Memex', 'note body');
    const res = await rpc(sock, { cmd: 'note', from: 'lead', op: 'read', target: 'Memex' });
    expect(res).toEqual({ ok: true, data: { content: 'note body' } });
  });

  it('note verbs are denied without a leash', async () => {
    const res = await rpc(sock, { cmd: 'note', from: 'lead', op: 'read', target: 'Memex' });
    expect(res).toEqual({ ok: false, error: 'no connected note named "Memex"' });
  });

  it('note read --chain concatenates the whole note cluster', async () => {
    addNote('n1', 'Note One', 'first');
    addNote('n2', 'Note Two', 'second');
    graph.connect('n1', 'n2');
    const res = await rpc(sock, { cmd: 'note', from: 'lead', op: 'read', target: 'Note One', chain: true });
    const content = (res.data as { content?: string }).content ?? '';
    expect(content).toContain('===== NOTE: Note One =====');
    expect(content).toContain('first');
    expect(content).toContain('===== NOTE: Note Two =====');
    expect(content).toContain('second');
  });

  it('note append and write mutate the store and notify', async () => {
    addNote('n1', 'Memex', 'base');
    await rpc(sock, { cmd: 'note', from: 'lead', op: 'append', target: 'Memex', body: ' more' });
    expect(notes.append).toHaveBeenCalledWith('n1', ' more', true);
    await rpc(sock, { cmd: 'note', from: 'lead', op: 'write', target: 'Memex', body: 'full' });
    expect(notes.write).toHaveBeenCalledWith('n1', 'full', true);
  });

  // ── portal verbs ───────────────────────────────────────────────────
  it('portal new creates a portal wired to the caller', async () => {
    const res = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'new', target: '', arg: 'https://x' });
    expect(res.ok).toBe(true);
    const id = (res.data as { id?: string }).id ?? '';
    expect(id.startsWith('p')).toBe(true);
    expect(graph.kindOf(id)).toBe('portal');
    expect(graph.areConnected('lead', id)).toBe(true);
    expect(portals.notifyCreated).toHaveBeenCalled();
  });

  it('portal navigate drives the connected portal', async () => {
    addPortal('p1', 'Portal One');
    const res = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'navigate', target: 'Portal One', arg: 'https://x' });
    expect(res).toEqual({ ok: true, data: { ok: true } });
    expect(portals.navigate).toHaveBeenCalledWith('p1', 'https://x');
  });

  it('portal ops are denied without a leash', async () => {
    const res = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'navigate', target: 'p1', arg: 'https://x' });
    expect(res).toEqual({ ok: false, error: 'no connected portal named "p1"' });
  });

  it('an unknown portal op errors', async () => {
    addPortal('p1', 'Portal One');
    const res = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'frobnicate', target: 'p1' } as unknown as BrokerRequest);
    expect(res).toEqual({ ok: false, error: 'unknown portal op' });
  });

  it('a throwing portal op surfaces as ok:false', async () => {
    addPortal('p1', 'Portal One');
    portals.navigate.mockImplementationOnce(() => { throw new Error('boom'); });
    const res = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'navigate', target: 'p1', arg: 'https://x' });
    expect(res).toEqual({ ok: false, error: 'boom' });
  });

  it('answers the socket when portal op=new throws outside the internal try', async () => {
    // The `new` branch runs before handlePortal's internal try; a throw there
    // must be answered by the dispatch catch, not leaked as an unhandled
    // rejection.
    portals.create.mockImplementationOnce(() => { throw new Error('portal factory exploded'); });
    const res = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'new', target: '', arg: 'https://x' });
    expect(res).toEqual({ ok: false, error: 'portal factory exploded' });
  });

  it('portal read ops return their payloads', async () => {
    addPortal('p1', 'Portal One');
    const js = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'js', target: 'p1', arg: '1+1' });
    expect((js.data as { result?: unknown }).result).toBe(42);
    const dom = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'dom', target: 'p1', arg: 'body' });
    expect((dom.data as { html?: string }).html).toBe('<div>hi</div>');
    const consoleRes = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'console', target: 'p1' });
    expect((consoleRes.data as { output?: string }).output).toBe('console line');
  });

  it('portal automation ops return their results', async () => {
    addPortal('p1', 'Portal One');
    const click = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'click', target: 'p1', arg: '#btn' });
    expect((click.data as { clicked?: boolean }).clicked).toBe(true);
    const type = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'type', target: 'p1', arg: '#in', value: 'hi' });
    expect((type.data as { typed?: boolean }).typed).toBe(true);
    const scroll = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'scroll', target: 'p1', x: 1, y: 2 });
    expect((scroll.data as { scrolled?: boolean }).scrolled).toBe(true);
    const shot = await rpc(sock, { cmd: 'portal', from: 'lead', op: 'screenshot', target: 'p1' });
    expect((shot.data as { path?: string }).path).toBe('/tmp/shot.png');
  });

  // ── contract management ops ────────────────────────────────────────
  it('contract list returns the contract names', async () => {
    addVerdict();
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'list' });
    expect(res).toEqual({ ok: true, data: { contracts: ['verdict'] } });
  });

  it('contract inspect returns the contract', async () => {
    addVerdict();
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'inspect', target: 'verdict' });
    expect((res.data as { contract?: { name?: string } }).contract?.name).toBe('verdict');
  });

  it('contract inspect of an unknown contract errors', async () => {
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'inspect', target: 'ghost' });
    expect(res).toEqual({ ok: false, error: 'no contract named "ghost"' });
  });

  it('contract create persists a valid contract', async () => {
    const res = await rpc(sock, {
      cmd: 'contract', from: 'lead', op: 'create', target: 'c1',
      schema: '{"type":"object"}', attempts: 5, timeoutMs: 2_000,
      rejectionPrompt: 'again', fallback: '{"ok":false}',
    });
    expect(res).toEqual({ ok: true, data: { name: 'c1' } });
    expect(contracts.list().map((c) => c.name)).toContain('c1');
  });

  it('contract create rejects missing name, duplicates and missing schema', async () => {
    const noName = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', schema: '{"type":"object"}' });
    expect(noName).toEqual({ ok: false, error: 'contract create needs a name' });
    await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c1', schema: '{"type":"object"}' });
    const dup = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c1', schema: '{"type":"object"}' });
    expect(dup).toEqual({ ok: false, error: 'a contract named "c1" already exists' });
    const noSchema = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c2' });
    expect(noSchema).toEqual({ ok: false, error: 'contract create needs --schema <json>' });
  });

  it('contract create rejects invalid schema input', async () => {
    const notJson = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c1', schema: '{nope' });
    expect(notJson).toEqual({ ok: false, error: 'schema is not valid JSON' });
    const notObject = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c1', schema: '[1,2]' });
    expect(notObject).toEqual({ ok: false, error: 'schema must be a JSON object' });
    const badSchema = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c1', schema: '{"$ref":"#/definitions/missing"}' });
    expect(badSchema).toEqual({ ok: false, error: 'schema is not a valid JSON Schema' });
  });

  it('contract create rejects an invalid fallback', async () => {
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'create', target: 'c1', schema: '{"type":"object"}', fallback: '{nope' });
    expect(res).toEqual({ ok: false, error: 'fallback is not valid JSON' });
  });

  it('contract edit renames and replaces fields', async () => {
    addVerdict();
    const res = await rpc(sock, {
      cmd: 'contract', from: 'lead', op: 'edit', target: 'verdict',
      name: 'verdict2', schema: '{"type":"object"}', fallback: '{"x":1}',
    });
    expect(res).toEqual({ ok: true, data: { name: 'verdict2' } });
    expect(contracts.list().find((c) => c.name === 'verdict2')?.schema).toEqual({ type: 'object' });
  });

  it('contract edit of an unknown contract errors', async () => {
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'edit', target: 'ghost', name: 'x' });
    expect(res).toEqual({ ok: false, error: 'no contract named "ghost"' });
  });

  it('contract delete removes the contract', async () => {
    addVerdict();
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'delete', target: 'verdict' });
    expect(res).toEqual({ ok: true, data: { deleted: true } });
    expect(contracts.list()).toHaveLength(0);
  });

  it('contract delete of an unknown contract errors', async () => {
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'delete', target: 'ghost' });
    expect(res).toEqual({ ok: false, error: 'no contract named "ghost"' });
  });

  it('an unknown contract op errors', async () => {
    const res = await rpc(sock, { cmd: 'contract', from: 'lead', op: 'frobnicate' } as unknown as BrokerRequest);
    expect(res).toEqual({ ok: false, error: 'unknown contract op' });
  });

  // ── ask --contract (loop-until-valid) ──────────────────────────────
  it('ask --contract returns the value when the first answer validates', async () => {
    addTerminal('peer1', 'Peer One');
    addVerdict({ timeoutMs: 42 });
    answers.set('peer1', '{"decision":"approve"}');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'decide', contract: 'verdict' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ decision: 'approve' });
    // Per-attempt timeout is clamped to the 1s floor.
    expect(awaited).toEqual([{ to: 'peer1', timeoutMs: 1_000 }]);
    expect(injected[0].body).toContain('Return exactly one JSON object');
  });

  it('ask --contract re-injects the rejection prompt until the budget runs out', async () => {
    addTerminal('peer1', 'Peer One');
    addVerdict({ maxAttempts: 2 });
    answers.set('peer1', '{"decision":7}');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'decide', contract: 'verdict' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ decision: 'FALLBACK' });
    expect(injected).toHaveLength(2);
    expect(awaited).toHaveLength(2);
    expect(injected[1].body).toContain('Validation errors');
    expect(injected[1].body).toContain('RETRY_PROMPT');
  });

  it('ask --contract falls back when the peer never emits JSON', async () => {
    addTerminal('peer1', 'Peer One');
    addVerdict();
    answers.set('peer1', '');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'decide', contract: 'verdict' });
    expect(res.data).toEqual({ decision: 'FALLBACK' });
    expect(injected[1].body).toContain('no JSON object found');
  });

  it('ask --contract tolerates brace noise around a valid answer', async () => {
    addTerminal('peer1', 'Peer One');
    addVerdict();
    answers.set('peer1', 'noise {not json} {"decision":"ok"}');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'decide', contract: 'verdict' });
    expect(res.data).toEqual({ decision: 'ok' });
  });

  it('ask --contract with an unknown contract errors', async () => {
    addTerminal('peer1', 'Peer One');
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'x', contract: 'nope' });
    expect(res).toEqual({ ok: false, error: 'no contract named "nope"' });
  });

  it('ask --contract with an invalid schema errors', async () => {
    addTerminal('peer1', 'Peer One');
    contracts.create({
      name: 'bad', schema: { $ref: '#/definitions/missing' }, maxAttempts: 1,
      timeoutMs: 1_000, rejectionPrompt: '', fallback: null,
    });
    const res = await rpc(sock, { cmd: 'ask', from: 'lead', target: 'peer1', body: 'x', contract: 'bad' });
    expect(res.ok).toBe(false);
    expect((res.error ?? '').includes('has an invalid JSON Schema')).toBe(true);
  });

  // ── walker verbs ───────────────────────────────────────────────────
  it('recruit spawns a teammate wired to the Walker', async () => {
    walkers.add('lead');
    // No --agent: defaults to the shell preset.
    const res = await rpc(sock, { cmd: 'recruit', from: 'lead', role: 'scout' });
    expect(res.ok).toBe(true);
    const id = (res.data as { id?: string }).id ?? '';
    expect(graph.areConnected('lead', id)).toBe(true);
    expect(spawned[0]).toMatchObject({ preset: 'shell', name: 'scout', walker: false });
    expect((res.data as { stableId?: string }).stableId).toBeTruthy();
  });

  it('recruit with an unknown preset errors', async () => {
    walkers.add('lead');
    const res = await rpc(sock, { cmd: 'recruit', from: 'lead', agent: 'nope', role: 'scout' });
    expect(res).toEqual({ ok: false, error: 'no preset named "nope"' });
  });

  it('recruit with an unknown role errors', async () => {
    walkers.add('lead');
    const res = await rpc(sock, { cmd: 'recruit', from: 'lead', agent: 'shell', role: 'nope' });
    expect(res).toEqual({ ok: false, error: 'no role named "nope"' });
  });

  it('recruit --floor places the teammate on the floor', async () => {
    walkers.add('lead');
    const res = await rpc(sock, { cmd: 'recruit', from: 'lead', agent: 'shell', floor: 'featX' });
    expect(res.ok).toBe(true);
    expect(spawned[0]).toMatchObject({ floorName: 'featX', workspaceId: 'layer-fx', cwd: '/tmp/fx' });
  });

  it('recruit --floor with an unknown floor errors', async () => {
    walkers.add('lead');
    const res = await rpc(sock, { cmd: 'recruit', from: 'lead', agent: 'shell', floor: 'nope' });
    expect(res).toEqual({ ok: false, error: 'no floor named "nope"' });
  });

  it('dismiss kills a connected recruit', async () => {
    walkers.add('lead');
    graph.addNode('r9', 'scout', 'terminal');
    terminals.add('r9');
    graph.connect('lead', 'r9');
    const res = await rpc(sock, { cmd: 'dismiss', from: 'lead', target: 'scout' });
    expect(res).toEqual({ ok: true });
    expect(killed).toEqual(['r9']);
  });

  it('dismiss of an unwired recruit errors', async () => {
    walkers.add('lead');
    const res = await rpc(sock, { cmd: 'dismiss', from: 'lead', target: 'scout' });
    expect(res).toEqual({ ok: false, error: 'no connected recruit named "scout"' });
  });

  it('dismiss without a target names the empty recruit', async () => {
    walkers.add('lead');
    const res = await rpc(sock, { cmd: 'dismiss', from: 'lead' });
    expect(res).toEqual({ ok: false, error: 'no connected recruit named ""' });
  });

  it('skips responding when the caller socket has already died', async () => {
    addTerminal('peer1', 'Peer One');
    slowTargets.add('peer1'); // the answer lands after the client is gone
    answers.set('peer1', 'LATE');
    await new Promise<void>((resolve) => {
      const socket = net.connect(sock);
      socket.on('connect', () => {
        socket.write(JSON.stringify({ cmd: 'ask', from: 'lead', target: 'peer1', body: 'x' }) + '\n');
        socket.destroy(); // hang up before the broker's response attempt
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve());
    });
    await wait(700); // let the delayed respond hit the destroyed socket
    // Broker is still alive and serving other requests afterwards.
    const res = await rpc(sock, { cmd: 'list', from: 'lead' });
    expect(res.ok).toBe(true);
  });

  it('assign relabels a connected recruit', async () => {
    walkers.add('lead');
    roles.list.mockReturnValue([
      { id: 'r-scout', name: 'scout', instructions: 'Scout ahead.' },
      { id: 'r-sentry', name: 'sentry', instructions: 'Stand guard.' },
    ]);
    graph.addNode('r9', 'scout', 'terminal');
    terminals.add('r9');
    graph.connect('lead', 'r9');
    const res = await rpc(sock, { cmd: 'assign', from: 'lead', target: 'scout', role: 'sentry' });
    expect(res).toEqual({ ok: true, data: { name: 'sentry', path: '/roles/sentry' } });
    expect(graph.name('r9')).toBe('sentry');
  });

  it('assign needs a role', async () => {
    walkers.add('lead');
    graph.addNode('r9', 'scout', 'terminal');
    terminals.add('r9');
    graph.connect('lead', 'r9');
    const res = await rpc(sock, { cmd: 'assign', from: 'lead', target: 'scout' });
    expect(res).toEqual({ ok: false, error: 'assign needs a role' });
  });

  it('assign with an unknown role errors', async () => {
    walkers.add('lead');
    graph.addNode('r9', 'scout', 'terminal');
    terminals.add('r9');
    graph.connect('lead', 'r9');
    const res = await rpc(sock, { cmd: 'assign', from: 'lead', target: 'scout', role: 'nope' });
    expect(res).toEqual({ ok: false, error: 'no role named "nope"' });
  });

  it('walker verbs are denied for a non-Walker terminal', async () => {
    const res = await rpc(sock, { cmd: 'recruit', from: 'lead', agent: 'shell', role: 'scout' });
    expect(res.ok).toBe(false);
    expect((res.error ?? '').includes('not a Walker terminal')).toBe(true);
  });

  // ── list ───────────────────────────────────────────────────────────
  it('list annotates the floor only for terminal peers', async () => {
    addTerminal('floorPeer', 'Floor Peer');
    addNote('n1', 'Note One', '');
    const res = await rpc(sock, { cmd: 'list', from: 'lead' });
    const peers = (res.data as { peers?: Array<{ name: string; floor: string }> }).peers ?? [];
    expect(peers).toContainEqual(expect.objectContaining({ name: 'Floor Peer', floor: 'featX' }));
    expect(peers).toContainEqual(expect.objectContaining({ name: 'Note One', floor: '' }));
  });
});
