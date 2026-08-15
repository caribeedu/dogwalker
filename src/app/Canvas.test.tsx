/**
 * Characterization tests for Canvas.tsx (the React Flow orchestration layer).
 *
 * Strategy (repo pattern — see PreviewNode.test.tsx): the Canvas must not mount
 * real React Flow / xterm / WebGL in jsdom, so:
 *  - `@xyflow/react` is mocked with a fake ReactFlow that renders children and
 *    exposes its received props (handlers included) on `h.state.lastProps`,
 *    plus a stateful `useNodesState` whose `onNodesChange` applies standard
 *    React Flow changes (select/remove/position/dimensions).
 *  - `./terminalService` is mocked (xterm needs real DOM/canvas).
 *  - The six node components are stubbed (they have their own test files).
 *  - `../../tools/perf-probe` is mocked (smoke harness).
 *  - `window.dw` is a fresh Proxy-backed stub per test: subscription methods
 *    register callbacks (driven via `h.emit`), everything else auto-mocks.
 *
 * The file also drives the query-param-gated e2e harnesses (smoke/palettetest/
 * attentiontest/themetest/composertest/notetest/persisttest/snaptest/grouptest/
 * fsnodetest/fileopstest/editortest/searchtest/imgtest/portaltest/layouttest)
 * with fake timers, asserting on the `... RESULT` console lines they print.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { Canvas } from './Canvas';

const h = vi.hoisted(() => {
  const rf = {
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    setViewport: vi.fn(),
    screenToFlowPosition: vi.fn((p: { x: number; y: number }) => ({ x: p.x, y: p.y })),
  };
  const terminals = {
    write: vi.fn(),
    create: vi.fn(),
    dispose: vi.fn(),
    setTier: vi.fn(),
    stats: vi.fn(() => ({ tier1: 0, tier2: 0, tier3: 0, webglContexts: 0, contextLosses: 0 })),
    setTheme: vi.fn(),
    themeBg: vi.fn(),
  };
  const perfProbe = { runPerfProbe: vi.fn() };
  const state: { lastProps: Record<string, any> | null } = { lastProps: null };
  const dwRef: { current: any } = { current: null };
  /** Fire an event into the current window.dw subscription registry. */
  const emit = (name: string, ...args: any[]) => {
    const subs = dwRef.current?.__subs;
    for (const cb of [...(subs?.[name] ?? [])]) cb(...args);
  };
  return { rf, terminals, perfProbe, state, dwRef, emit };
});

vi.mock('@xyflow/react', async () => {
  const ReactMod = await import('react');
  const applyNodeChanges = (changes: any[], nodes: any[]): any[] => {
    let next = nodes;
    for (const ch of changes) {
      if (!ch || typeof ch !== 'object') continue;
      if (ch.type === 'add') next = [...next, ch.item];
      else if (ch.type === 'remove') next = next.filter((n) => n.id !== ch.id);
      else if (ch.type === 'select')
        next = next.map((n) => (n.id === ch.id ? { ...n, selected: ch.selected } : n));
      else if (ch.type === 'position')
        next = next.map((n) =>
          n.id === ch.id
            ? { ...n, position: ch.position ?? n.position, dragging: ch.dragging ?? n.dragging }
            : n,
        );
      else if (ch.type === 'dimensions')
        next = next.map((n) =>
          n.id === ch.id
            ? {
                ...n,
                measured: {
                  width: ch.dimensions?.width ?? n.measured?.width,
                  height: ch.dimensions?.height ?? n.measured?.height,
                },
              }
            : n,
        );
      else if (ch.type === 'reset')
        next = next.map((n) => ({ ...n, selected: false, dragging: false }));
    }
    return next;
  };
  return {
    ReactFlow: (props: any) => {
      h.state.lastProps = props;
      return ReactMod.createElement(
        'div',
        { role: 'canvas', className: 'react-flow' },
        props.children,
      );
    },
    MiniMap: (props: any) => {
      // The real MiniMap calls these per-node; exercise the callbacks so the
      // color/stroke branches execute.
      props.nodeColor?.({ type: 'note' });
      props.nodeColor?.({ type: 'terminal' });
      props.nodeStrokeColor?.({ type: 'note' });
      props.nodeStrokeColor?.({ type: 'terminal', data: { attention: true } });
      props.nodeStrokeColor?.({ type: 'terminal', data: { attention: false } });
      return ReactMod.createElement('div', { className: 'react-flow__minimap' });
    },
    Background: () => null,
    ViewportPortal: (props: any) =>
      ReactMod.createElement('div', { className: 'dw-viewport-portal' }, props.children),
    ReactFlowProvider: (props: any) =>
      ReactMod.createElement(ReactMod.Fragment, null, props.children),
    ConnectionMode: { Loose: 'loose', Strict: 'strict' },
    useNodesState: (initial: any[]) => {
      const [nodes, setNodes] = ReactMod.useState(initial);
      const onNodesChange = ReactMod.useCallback((changes: any[]) => {
        setNodes((nds: any[]) => applyNodeChanges(changes, nds));
      }, []);
      return [nodes, setNodes, onNodesChange];
    },
    useReactFlow: () => h.rf,
  };
});

vi.mock('./terminalService', () => ({ terminals: h.terminals }));
vi.mock('../../tools/perf-probe', () => ({ runPerfProbe: h.perfProbe.runPerfProbe }));
vi.mock('./TerminalNode', () => ({ TerminalNode: () => null }));
vi.mock('./NoteNode', () => ({ NoteNode: () => null }));
vi.mock('./GroupNode', () => ({ GroupNode: () => null }));
vi.mock('./FileTreeNode', () => ({ FileTreeNode: () => null }));
vi.mock('./PreviewNode', () => ({ PreviewNode: () => null }));
vi.mock('./PortalNode', () => ({ PortalNode: () => null }));
// editortest harness: force the CodeMirror mount to fail so the catch branch
// (which records cmError) is exercised — no other code imports these.
vi.mock('@codemirror/state', () => ({
  EditorState: {
    create: () => {
      throw new Error('cm fail');
    },
  },
}));
vi.mock('@codemirror/view', () => ({ EditorView: {} }));
vi.mock('codemirror', () => ({ basicSetup: {} }));

// ---- window.dw stub ---------------------------------------------------------
function makeDw() {
  const subs: Record<string, Set<(e: any) => void>> = {};
  let seq = 0;
  const on = (name: string) =>
    vi.fn((cb: (e: any) => void) => {
      (subs[name] ??= new Set()).add(cb);
      return () => {
        subs[name]?.delete(cb);
      };
    });
  const target: Record<string, unknown> = {
    onData: on('data'),
    onExit: on('exit'),
    onAttention: on('attention'),
    onGraph: on('graph'),
    onRecruited: on('recruited'),
    onDismissed: on('dismissed'),
    onReassigned: on('reassigned'),
    onPortalCreated: on('portalCreated'),
    onHistory: on('history'),
    onNoteUpdate: on('noteUpdate'),
    onPortalNav: on('portalNav'),
    onRoutineUpdate: on('routineUpdate'),
    graph: vi.fn(async () => ({ nodes: [], edges: [] })),
    loadLayer: vi.fn(async () => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })),
    listTerminals: vi.fn(async () => []),
    spawn: vi.fn(async () => ({ id: `term-${++seq}` })),
    serialize: vi.fn(async () => ''),
    portalState: vi.fn(async () => null),
    listPresets: vi.fn(async () => [
      { id: 'shell', name: 'Shell', icon: 'term', command: 'bash', builtin: true },
    ]),
    listRoles: vi.fn(async () => []),
    listContracts: vi.fn(async () => []),
    getDraft: vi.fn(async () => ''),
    saveDropImage: vi.fn(async () => '/tmp/shot.png'),
    history: vi.fn(async () => []),
    readDir: vi.fn(async () => ({ path: '', entries: [], error: undefined })),
    readFile: vi.fn(async () => ''),
    readImage: vi.fn(async () => ''),
    statEntry: vi.fn(async () => null),
    registerNote: vi.fn(async () => ''),
    readNote: vi.fn(async () => ''),
    loadWorkspace: vi.fn(async () => ({
      id: 'ws-1',
      name: 'ws',
      icon: 'x',
      cwd: '/',
      layout: { nodes: [], edges: [] },
    })),
    getSettings: vi.fn(async () => ({
      themeName: 'Dogwalker Dark',
      lightThemeName: 'Dogwalker Light',
      followSystem: false,
      notifyOnAttention: true,
      miniSidebar: false,
    })),
    metrics: vi.fn(async () => []),
    searchFiles: vi.fn(async () => []),
    grepFiles: vi.fn(async () => []),
    __subs: subs,
  };
  // Anything not predefined becomes a no-op mock on first access.
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p as string];
      (t as Record<string, unknown>)[p as string] = vi.fn(() => undefined);
      return t[p as string];
    },
    set(t, p, v) {
      (t as Record<string, unknown>)[p as string] = v;
      return true;
    },
  });
}

// ---- helpers ----------------------------------------------------------------
type CanvasProps = ComponentProps<typeof Canvas>;

const nodesOf = (): any[] => (h.state.lastProps?.nodes as any[]) ?? [];
const findNode = (id: string) => nodesOf().find((n) => n.id === id);
const rfProps = () => h.state.lastProps as any;

function renderCanvas(overrides: Partial<CanvasProps> = {}) {
  const props: CanvasProps = {
    workspaceId: 'ws-1',
    workspaceCwd: '/home/test',
    floorId: 'ground',
    floorLabel: 'ground',
    isDev: false,
    notifyOnAttention: true,
    ...overrides,
  };
  const utils = render(<Canvas {...props} />);
  return { ...utils, props };
}

/** Flush microtasks (mocked promises) and optionally advance fake timers. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function withLayout(layout: Record<string, unknown>) {
  vi.mocked(window.dw.loadLayer).mockResolvedValue(layout as never);
  vi.mocked(window.dw.listTerminals).mockResolvedValue([]);
}

const termSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'terminal',
  stableId: 's1',
  name: 'shell-1',
  preset: 'shell',
  x: 0,
  y: 0,
  w: 560,
  h: 380,
  ...over,
});
const noteSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'note',
  stableId: 'ns1',
  name: 'note-1',
  x: 0,
  y: 0,
  w: 320,
  h: 240,
  ...over,
});
const groupSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'group',
  stableId: 'gs1',
  name: 'Group',
  x: 0,
  y: 0,
  w: 800,
  h: 500,
  ...over,
});
const fileTreeSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'filetree',
  stableId: 'fs1',
  name: 'files',
  rootPath: '/home/test',
  x: 0,
  y: 0,
  w: 340,
  h: 380,
  ...over,
});
const previewSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'preview',
  stableId: 'ps1',
  name: 'doc.txt',
  filePath: '/a/doc.txt',
  x: 0,
  y: 0,
  w: 320,
  h: 300,
  ...over,
});
const portalSpec = (over: Record<string, unknown> = {}) => ({
  kind: 'portal',
  stableId: 'pp1',
  name: 'portal-1',
  url: 'https://example.com',
  partition: 'part1',
  x: 0,
  y: 0,
  w: 720,
  h: 520,
  ...over,
});

function makeDataTransfer(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    types: [...map.keys()],
    dropEffect: 'none',
    effectAllowed: 'none',
    getData: (t: string) => map.get(t) ?? '',
    setData: (t: string, v: string) => {
      map.set(t, v);
    },
  };
}

function keydown(key: string, mods: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...mods }));
  });
}

function selectOnly(...ids: string[]) {
  act(() => {
    rfProps().onNodesChange(ids.map((id) => ({ type: 'select', id, selected: true })));
  });
}

function layoutOf(kinds: Array<Record<string, unknown>>) {
  return { nodes: kinds, edges: [] };
}

/** The broker's graph already contains registered portals (reconcile keeps them). */
function withGraphPortals(...ids: string[]) {
  vi.mocked(window.dw.graph).mockResolvedValue({
    nodes: ids.map((id) => ({ id, name: id, kind: 'portal' })),
    edges: [],
  });
}

// ---- setup ------------------------------------------------------------------
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/');
  h.state.lastProps = null;
  h.dwRef.current = makeDw();
  window.dw = h.dwRef.current as typeof window.dw;
  // jsdom does not expose the DataTransfer constructor (needed by fileopstest).
  vi.stubGlobal(
    'DataTransfer',
    class FakeDataTransfer {
      private m = new Map<string, string>();
      types: string[] = [];
      dropEffect = 'none';
      effectAllowed = 'none';
      setData(t: string, v: string) {
        this.m.set(t, v);
        this.types = [...this.m.keys()];
      }
      getData(t: string) {
        return this.m.get(t) ?? '';
      }
    },
  );
  vi.clearAllMocks();
  // Re-establish shared-mock default implementations after clear.
  h.rf.getViewport.mockImplementation(() => ({ x: 0, y: 0, zoom: 1 }));
  h.rf.screenToFlowPosition.mockImplementation((p: { x: number; y: number }) => ({
    x: p.x,
    y: p.y,
  }));
  h.terminals.stats.mockImplementation(() => ({
    tier1: 0,
    tier2: 0,
    tier3: 0,
    webglContexts: 0,
    contextLosses: 0,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('mount + subscriptions', () => {
  it('mounts the canvas chrome and wires the dw subscriptions', async () => {
    renderCanvas();
    await flush();
    expect(screen.getByRole('canvas')).toBeInTheDocument();
    // Palette + composer chrome from real children.
    expect(screen.getByTitle('New note')).toBeInTheDocument();
    expect(window.dw.onData).toHaveBeenCalledTimes(1);
    expect(window.dw.onExit).toHaveBeenCalledTimes(1);
    expect(window.dw.onAttention).toHaveBeenCalledTimes(1);
    expect(window.dw.onGraph).toHaveBeenCalledTimes(1);
    expect(window.dw.graph).toHaveBeenCalledTimes(1);
    // Subscriptions return unsubscribers; teardown calls them.
  });

  it('shows the empty state once the layer has loaded', async () => {
    renderCanvas();
    await flush();
    // Force a render after loaded.current flips (refs don't re-render).
    act(() => h.emit('graph', { nodes: [], edges: [] }));
    expect(screen.getByText('This workspace is empty')).toBeInTheDocument();
  });

  it('writes onData batches to the terminal service', async () => {
    renderCanvas();
    await flush();
    act(() => h.emit('data', [['t1', 'hello '], ['t2', 'world']]));
    expect(h.terminals.write).toHaveBeenNthCalledWith(1, 't1', 'hello ');
    expect(h.terminals.write).toHaveBeenNthCalledWith(2, 't2', 'world');
  });

  it('marks a terminal exited on onExit', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    act(() => h.emit('exit', id));
    expect(findNode(id)?.data.exited).toBe(true);
  });

  it('sets attention and notifies when the node is unselected and notifications are on', async () => {
    withLayout(layoutOf([termSpec({ name: 'Agent One' })]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    act(() => h.emit('attention', { id, value: true }));
    expect(findNode(id)?.data.attention).toBe(true);
    expect(window.dw.notify).toHaveBeenCalledWith('Dogwalker', 'Agent One needs attention');
    act(() => h.emit('attention', { id, value: false }));
    expect(findNode(id)?.data.attention).toBe(false);
  });

  it('suppresses the notification when the node is selected', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    selectOnly(id);
    act(() => h.emit('attention', { id, value: true }));
    expect(window.dw.notify).not.toHaveBeenCalled();
  });

  it('suppresses the notification when notifyOnAttention is false', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas({ notifyOnAttention: false });
    await flush();
    const id = nodesOf()[0].id;
    act(() => h.emit('attention', { id, value: true }));
    expect(window.dw.notify).not.toHaveBeenCalled();
    // Detection still lands on the node (invariant #8).
    expect(findNode(id)?.data.attention).toBe(true);
  });

  it('derives leash edges from the graph for nodes present on this canvas', async () => {
    withLayout(layoutOf([termSpec(), noteSpec()]));
    renderCanvas();
    await flush();
    const [t, n] = nodesOf();
    act(() =>
      h.emit('graph', {
        nodes: [
          { id: t.id, name: 'shell-1', kind: 'terminal' },
          { id: n.id, name: 'note-1', kind: 'note' },
        ],
        edges: [{ id: 'e1', a: t.id, b: n.id }],
      }),
    );
    expect(rfProps().edges).toEqual([
      {
        id: 'e1',
        source: t.id,
        target: n.id,
        sourceHandle: 'right',
        targetHandle: 'sink',
        type: 'leash',
      },
    ]);
  });

  it('applies onNodesChange selection and removal', async () => {
    withLayout(layoutOf([termSpec(), noteSpec()]));
    renderCanvas();
    await flush();
    const [t, n] = nodesOf();
    selectOnly(t.id, n.id);
    expect(nodesOf().every((x) => x.selected)).toBe(true);
    act(() => rfProps().onNodesChange([{ type: 'remove', id: n.id }]));
    expect(nodesOf().map((x) => x.id)).toEqual([t.id]);
  });
});

describe('rehydrate from saved layout', () => {
  it('spawns terminals from specs with geometry, name and spawn options', async () => {
    withLayout(
      layoutOf([
        termSpec({
          stableId: 's1',
          name: 'Coder',
          preset: 'claude',
          x: 10,
          y: 20,
          memoryLimitMB: 1024,
          walker: true,
          roleId: 'r1',
        }),
      ]),
    );
    renderCanvas();
    await flush();
    expect(window.dw.spawn).toHaveBeenCalledWith({
      preset: 'claude',
      name: 'Coder',
      cols: 80,
      rows: 24,
      workspaceId: 'ws-1',
      floorName: 'ground',
      stableId: 's1',
      cwd: '/home/test',
      memoryLimitMB: 1024,
      walker: true,
    });
    expect(window.dw.assignTerminalRole).toHaveBeenCalledWith('term-1', 'r1');
    const n = nodesOf()[0];
    expect(n.id).toBe('term-1');
    expect(n.type).toBe('terminal');
    expect(n.position).toEqual({ x: 10, y: 20 });
    expect(n.style).toEqual({ width: 560, height: 380 });
    expect(n.data).toMatchObject({
      name: 'Coder',
      preset: 'claude',
      tier: 3,
      exited: false,
      stableId: 's1',
      memoryLimitMB: 1024,
      walker: true,
      roleId: 'r1',
    });
  });

  it('adopts a still-running terminal via adoptId (create + serialize replay)', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1' })]));
    vi.mocked(window.dw.listTerminals).mockResolvedValue([
      { id: 'live-9', stableId: 's1', name: 'Coder', preset: 'claude' },
    ]);
    vi.mocked(window.dw.serialize).mockResolvedValue('screen snapshot');
    renderCanvas();
    await flush();
    expect(window.dw.spawn).not.toHaveBeenCalled();
    expect(h.terminals.create).toHaveBeenCalledWith('live-9');
    expect(window.dw.serialize).toHaveBeenCalledWith('live-9');
    expect(h.terminals.write).toHaveBeenCalledWith('live-9', 'screen snapshot');
    expect(window.dw.setMemoryLimit).toHaveBeenCalledWith('live-9', 0);
    expect(nodesOf()[0].id).toBe('live-9');
  });

  it('rehydrates notes, file trees, previews and portals alongside terminals', async () => {
    withGraphPortals('pp1');
    withLayout(
      layoutOf([groupSpec(), termSpec(), noteSpec(), fileTreeSpec(), previewSpec(), portalSpec()]),
    );
    renderCanvas();
    await flush();
    const types = nodesOf().map((n) => n.type);
    // Group first (parents precede children), then the rest in layout order.
    expect(types[0]).toBe('group');
    expect(new Set(types)).toEqual(
      new Set(['group', 'terminal', 'note', 'filetree', 'preview', 'portal']),
    );
    expect(window.dw.registerNote).toHaveBeenCalledWith('ns1', 'note-1');
    expect(window.dw.portalRegister).toHaveBeenCalledWith('pp1', 'portal-1');
    expect(findNode('fs1')?.data.rootPath).toBe('/home/test');
    expect(findNode('ps1')?.data.filePath).toBe('/a/doc.txt');
    expect(findNode('pp1')?.data.partition).toBe('part1');
    expect(nodesOf()[0].style.zIndex).toBe(-1);
  });

  it('re-parents members and wires layout edges through live ids', async () => {
    withLayout(
      layoutOf([
        groupSpec(),
        termSpec({ stableId: 's1', parentStableId: 'gs1' }),
        noteSpec({ stableId: 'ns1' }),
      ]),
    );
    vi.mocked(window.dw.loadLayer).mockResolvedValue({
      nodes: [groupSpec(), termSpec({ parentStableId: 'gs1' }), noteSpec()],
      edges: [['s1', 'ns1']],
    } as never);
    renderCanvas();
    await flush();
    const t = findNode('term-1');
    expect(t.parentId).toBe('gs1');
    expect(t.extent).toBe('parent');
    expect(findNode('ns1').parentId).toBeUndefined();
    expect(window.dw.connect).toHaveBeenCalledWith('term-1', 'ns1');
  });

  it('restores the saved viewport', async () => {
    withLayout({ nodes: [], edges: [], viewport: { x: 123, y: 45, zoom: 0.5 } });
    renderCanvas();
    await flush();
    expect(h.rf.setViewport).toHaveBeenCalledWith({ x: 123, y: 45, zoom: 0.5 });
  });

  it('uses the floor id as the layer when the floor is not ground', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas({ floorId: 'fl-1', floorLabel: 'Feature' });
    await flush();
    expect(window.dw.loadLayer).toHaveBeenCalledWith('ws-1', 'fl-1');
    expect(window.dw.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'fl-1', floorName: 'Feature' }),
    );
  });
});

describe('palette spawn helpers', () => {
  it('spawns a terminal through the palette preset modal', async () => {
    renderCanvas();
    await flush();
    fireEvent.click(screen.getByTitle('New terminal — pick a preset and role'));
    await flush();
    fireEvent.click(screen.getByText('Shell'));
    fireEvent.click(screen.getByText('Create terminal'));
    await flush();
    expect(window.dw.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'shell', name: 'shell-1', cwd: '/home/test' }),
    );
    expect(nodesOf()).toHaveLength(1);
    expect(nodesOf()[0].data.name).toBe('shell-1');
    // Grid placement: first spawn sits at the origin.
    expect(nodesOf()[0].position).toEqual({ x: 0, y: 0 });
  });

  it('adds a note from the palette', async () => {
    renderCanvas();
    await flush();
    fireEvent.click(screen.getByTitle('New note'));
    await flush();
    expect(window.dw.registerNote).toHaveBeenCalledTimes(1);
    const n = nodesOf()[0];
    expect(n.type).toBe('note');
    expect(n.data.name).toBe('note-1');
    expect(n.data.stableId).toBe(n.id);
  });

  it('adds a file tree from the palette rooted at the workspace cwd', async () => {
    renderCanvas();
    await flush();
    fireEvent.click(screen.getByTitle('New file tree'));
    await flush();
    const n = nodesOf()[0];
    expect(n.type).toBe('filetree');
    expect(n.data.rootPath).toBe('/home/test');
  });

  it('adds a portal from the palette', async () => {
    renderCanvas();
    await flush();
    fireEvent.click(screen.getByTitle('New portal (embedded browser)'));
    await flush();
    expect(window.dw.portalRegister).toHaveBeenCalledTimes(1);
    const n = nodesOf()[0];
    expect(n.type).toBe('portal');
    expect(n.data.name).toBe('portal-1');
    expect(n.data.partition).toBe(n.data.stableId);
  });
});

describe('context menu + layout ops', () => {
  async function renderTwoTerminals() {
    withLayout(layoutOf([termSpec({ stableId: 's1' }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    return nodesOf().map((n) => n.id);
  }

  it('opens the context menu with the selection count and aligns left', async () => {
    const [a, b] = await renderTwoTerminals();
    selectOnly(a, b);
    act(() =>
      rfProps().onNodeContextMenu(
        { preventDefault: vi.fn(), clientX: 100, clientY: 50 },
        findNode(a),
      ),
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Align left'));
    expect(findNode(a).position.x).toBe(0);
    expect(findNode(b).position.x).toBe(0);
    // The window click listener closed the menu.
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });

  it('right-clicking an unselected node selects only it', async () => {
    const [a, b] = await renderTwoTerminals();
    selectOnly(b);
    act(() =>
      rfProps().onNodeContextMenu({ preventDefault: vi.fn(), clientX: 10, clientY: 10 }, findNode(a)),
    );
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(findNode(a).selected).toBe(true);
    expect(findNode(b).selected).toBe(false);
  });

  it('sets the memory limit from the menu on a single selected terminal', async () => {
    const [a] = await renderTwoTerminals();
    selectOnly(a);
    act(() =>
      rfProps().onNodeContextMenu(
        { preventDefault: vi.fn(), clientX: 10, clientY: 10 },
        findNode(a),
      ),
    );
    fireEvent.click(screen.getByText('512M'));
    expect(window.dw.setMemoryLimit).toHaveBeenCalledWith(a, 512);
    expect(findNode(a).data.memoryLimitMB).toBe(512);
  });

  it('distributes and tidies a selection from the context menu', async () => {
    withLayout(
      layoutOf([
        termSpec({ stableId: 's1', x: 0 }),
        termSpec({ stableId: 's2', x: 900 }),
        termSpec({ stableId: 's3', x: 1400 }),
      ]),
    );
    renderCanvas();
    await flush();
    const [a, b, c] = nodesOf().map((n) => n.id);
    selectOnly(a, b, c);
    const openMenu = () =>
      act(() =>
        rfProps().onNodeContextMenu(
          { preventDefault: vi.fn(), clientX: 10, clientY: 10 },
          findNode(a),
        ),
      );
    openMenu();
    fireEvent.click(screen.getByText('Distribute horizontally'));
    // Even gaps: middle node lands at 700 between 560 and 1400.
    expect(findNode(b).position.x).toBe(700);
    expect(findNode(a).position.x).toBe(0);
    expect(findNode(c).position.x).toBe(1400);
    openMenu();
    fireEvent.click(screen.getByText('Tidy'));
    // 3 boxes → 2 columns: (0,0), (600,0), (0,420).
    expect(findNode(a).position).toEqual({ x: 0, y: 0 });
    expect(findNode(b).position).toEqual({ x: 600, y: 0 });
    expect(findNode(c).position).toEqual({ x: 0, y: 420 });
  });

  it('closes the menu on Escape', async () => {
    const [a] = await renderTwoTerminals();
    selectOnly(a);
    act(() =>
      rfProps().onNodeContextMenu({ preventDefault: vi.fn(), clientX: 10, clientY: 10 }, findNode(a)),
    );
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    keydown('Escape');
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });
});

describe('keyboard shortcuts', () => {
  it('Ctrl+Shift+P focuses the composer', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    keydown('p', { ctrlKey: true, shiftKey: true });
    expect(document.activeElement?.className).toContain('dw-composer-textarea');
  });

  it('Shift+A cycles attention terminals and centers the viewport', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1' }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    const [a, b] = nodesOf().map((n) => n.id);
    act(() => h.emit('attention', { id: a, value: true }));
    act(() => h.emit('attention', { id: b, value: true }));
    keydown('a', { shiftKey: true });
    expect(findNode(a).selected).toBe(true);
    expect(h.rf.setViewport).toHaveBeenCalled();
    keydown('a', { shiftKey: true });
    expect(findNode(b).selected).toBe(true);
  });

  it('Shift+A does nothing with no attention terminals', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    h.rf.setViewport.mockClear();
    keydown('a', { shiftKey: true });
    expect(h.rf.setViewport).not.toHaveBeenCalled();
  });

  it('Shift+M toggles the minimap', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    expect(document.querySelector('.react-flow__minimap')).not.toBeNull();
    keydown('m', { shiftKey: true });
    expect(document.querySelector('.react-flow__minimap')).toBeNull();
  });

  it('Shift+T tidies the selection', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1' }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    const [a, b] = nodesOf().map((n) => n.id);
    selectOnly(a, b);
    keydown('t', { shiftKey: true });
    // tidy: 2 boxes → 2 columns, col width 560+40.
    expect(findNode(a).position).toEqual({ x: 0, y: 0 });
    expect(findNode(b).position).toEqual({ x: 600, y: 0 });
  });

  it('g groups the selection and Shift+G ungroups it', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1' }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    const [a, b] = nodesOf().map((n) => n.id);
    selectOnly(a, b);
    keydown('g');
    const group = nodesOf()[0];
    expect(group.type).toBe('group');
    expect(findNode(a).parentId).toBe(group.id);
    expect(findNode(a).extent).toBe('parent');
    // Relative positions: group frame starts at (-28, -58).
    expect(findNode(a).position).toEqual({ x: 28, y: 58 });
    // Select the group itself, then Shift+G ungroups in place.
    act(() =>
      rfProps().onNodesChange([
        { type: 'select', id: a, selected: false },
        { type: 'select', id: b, selected: false },
        { type: 'select', id: group.id, selected: true },
      ]),
    );
    keydown('g', { shiftKey: true });
    expect(nodesOf().some((n) => n.type === 'group')).toBe(false);
    expect(findNode(a).parentId).toBeUndefined();
    // Absolute position preserved: group(-28,-58) + rel(28,58) = (0,0).
    expect(findNode(a).position).toEqual({ x: 0, y: 0 });
  });
});

describe('groups via window events', () => {
  it('renames a group on dw:group-rename', async () => {
    withLayout(layoutOf([groupSpec(), termSpec({ parentStableId: 'gs1' })]));
    renderCanvas();
    await flush();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('dw:group-rename', { detail: { id: 'gs1', name: 'Core' } }),
      );
    });
    expect(findNode('gs1').data.name).toBe('Core');
  });

  it('unparents members on dw:group-ungroup', async () => {
    withLayout(layoutOf([groupSpec(), termSpec({ parentStableId: 'gs1', x: 40, y: 50 })]));
    renderCanvas();
    await flush();
    const t = findNode('term-1');
    expect(t.parentId).toBe('gs1');
    act(() => {
      window.dispatchEvent(new CustomEvent('dw:group-ungroup', { detail: { id: 'gs1' } }));
    });
    expect(nodesOf().some((n) => n.type === 'group')).toBe(false);
    const after = findNode('term-1');
    expect(after.parentId).toBeUndefined();
    // abs = group(0,0) + rel(40,50) = (40,50)
    expect(after.position).toEqual({ x: 40, y: 50 });
  });
});

describe('snapping + drag/drop', () => {
  it('snaps a dragged node to a neighbour and renders guides', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1', x: 0 }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    const [a, b] = nodesOf().map((n) => n.id);
    // Drag A so its left edge is 5px from B's left edge (within threshold 8).
    const dragged = { ...findNode(a), position: { x: 615, y: 0 } };
    act(() => rfProps().onNodeDrag({} as never, dragged, [dragged]));
    expect(findNode(a).position.x).toBe(620);
    expect(document.querySelectorAll('.dw-guide').length).toBeGreaterThan(0);
  });

  it('skips snapping during a multi-selection drag', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1', x: 0 }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    const [a, b] = nodesOf().map((n) => n.id);
    selectOnly(a, b);
    const dragged = { ...findNode(a), position: { x: 615, y: 0 } };
    act(() => rfProps().onNodeDrag({} as never, dragged, [dragged]));
    expect(findNode(a).position.x).toBe(0);
    expect(document.querySelectorAll('.dw-guide').length).toBe(0);
  });

  it('clears guides on drag stop', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1', x: 0 }), termSpec({ stableId: 's2', x: 620 })]));
    renderCanvas();
    await flush();
    const a = nodesOf()[0].id;
    const dragged = { ...findNode(a), position: { x: 615, y: 0 } };
    act(() => rfProps().onNodeDrag({} as never, dragged, [dragged]));
    expect(document.querySelectorAll('.dw-guide').length).toBeGreaterThan(0);
    act(() => rfProps().onNodeDragStop());
    expect(document.querySelectorAll('.dw-guide').length).toBe(0);
  });

  it('persists the camera via onMoveEnd after the debounce', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    act(() => rfProps().onMoveEnd());
    await flush(500);
    expect(window.dw.saveLayer).toHaveBeenCalledWith(
      'ws-1',
      'ground',
      expect.objectContaining({ viewport: { x: 0, y: 0, zoom: 1 } }),
    );
  });

  it('turns a dropped file into a preview node centered on the drop point', async () => {
    vi.mocked(window.dw.statEntry).mockResolvedValue({
      name: 'spec.md',
      path: '/a/b/spec.md',
      isDir: false,
      size: 10,
      mtime: 0,
    });
    h.rf.screenToFlowPosition.mockReturnValue({ x: 100, y: 80 });
    renderCanvas();
    await flush();
    const dt = makeDataTransfer({ 'application/x-dogwalker-file': '/a/b/spec.md' });
    act(() =>
      rfProps().onDrop({
        clientX: 100,
        clientY: 80,
        preventDefault: vi.fn(),
        dataTransfer: dt,
      } as never),
    );
    await flush();
    const pv = nodesOf().find((n) => n.type === 'preview');
    expect(pv).toBeDefined();
    expect(pv.data.filePath).toBe('/a/b/spec.md');
    expect(pv.data.name).toBe('spec.md');
    expect(pv.position).toEqual({ x: -60, y: 60 }); // x - PV_W/2, y - 20
  });

  it('turns a dropped folder into a file tree rooted at it', async () => {
    vi.mocked(window.dw.statEntry).mockResolvedValue({
      name: 'src',
      path: '/a/src',
      isDir: true,
      size: 0,
      mtime: 0,
    });
    renderCanvas();
    await flush();
    const dt = makeDataTransfer({ 'application/x-dogwalker-file': '/a/src' });
    act(() =>
      rfProps().onDrop({
        clientX: 300,
        clientY: 100,
        preventDefault: vi.fn(),
        dataTransfer: dt,
      } as never),
    );
    await flush();
    const ft = nodesOf().find((n) => n.type === 'filetree');
    expect(ft).toBeDefined();
    expect(ft.data.rootPath).toBe('/a/src');
  });

  it('ignores drops that do not carry the dogwalker file mime', async () => {
    renderCanvas();
    await flush();
    const before = nodesOf().length;
    act(() =>
      rfProps().onDrop({
        clientX: 100,
        clientY: 80,
        preventDefault: vi.fn(),
        dataTransfer: makeDataTransfer({ 'text/plain': 'x' }),
      } as never),
    );
    await flush();
    expect(nodesOf().length).toBe(before);
    expect(window.dw.statEntry).not.toHaveBeenCalled();
  });

  it('allows dragover for the dogwalker file mime', async () => {
    renderCanvas();
    await flush();
    const pe = vi.fn();
    const dt: any = { types: ['application/x-dogwalker-file'], dropEffect: 'none' };
    act(() => rfProps().onDragOver({ preventDefault: pe, dataTransfer: dt } as never));
    expect(pe).toHaveBeenCalled();
    expect(dt.dropEffect).toBe('copy');
  });
});

describe('graph wiring', () => {
  it('connects two distinct nodes on onConnect', async () => {
    renderCanvas();
    await flush();
    act(() => rfProps().onConnect({ source: 'a', target: 'b' }));
    expect(window.dw.connect).toHaveBeenCalledWith('a', 'b');
    act(() => rfProps().onConnect({ source: 'a', target: 'a' }));
    expect(window.dw.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects deleted edges', async () => {
    renderCanvas();
    await flush();
    act(() => rfProps().onEdgesDelete([{ id: 'e1' }]));
    expect(window.dw.disconnect).toHaveBeenCalledWith('e1');
  });

  it('opens and closes the history panel on edge click', async () => {
    withLayout(layoutOf([termSpec(), noteSpec()]));
    renderCanvas();
    await flush();
    const [t, n] = nodesOf();
    act(() =>
      h.emit('graph', {
        nodes: [
          { id: t.id, name: 'shell-1', kind: 'terminal' },
          { id: n.id, name: 'note-1', kind: 'note' },
        ],
        edges: [{ id: 'e1', a: t.id, b: n.id }],
      }),
    );
    act(() => rfProps().onEdgeClick({} as never, { id: 'e1', source: t.id, target: n.id }));
    expect(screen.getByText(/shell-1 ⟷ note-1/)).toBeInTheDocument();
    fireEvent.click(document.querySelector('.dw-close') as HTMLElement);
    expect(screen.queryByText(/shell-1 ⟷ note-1/)).not.toBeInTheDocument();
  });
});

describe('persistence + teardown', () => {
  it('persists a debounced layer snapshot with stable ids and rounded geometry', async () => {
    withLayout(
      layoutOf([
        termSpec({ stableId: 's1', x: 10.4, y: 20.6, preset: 'claude', memoryLimitMB: 512 }),
        noteSpec({ stableId: 'ns1' }),
      ]),
    );
    renderCanvas();
    await flush();
    const [t, n] = nodesOf();
    act(() =>
      h.emit('graph', {
        nodes: [
          { id: t.id, name: 'shell-1', kind: 'terminal' },
          { id: n.id, name: 'note-1', kind: 'note' },
        ],
        edges: [{ id: 'e1', a: t.id, b: n.id }],
      }),
    );
    await flush(600);
    const call = vi.mocked(window.dw.saveLayer).mock.calls.at(-1)!;
    expect(call[0]).toBe('ws-1');
    expect(call[1]).toBe('ground');
    const layout = call[2] as unknown as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<[string, string]>;
      viewport: { x: number; y: number; zoom: number };
    };
    expect(layout.nodes).toHaveLength(2);
    expect(layout.nodes[0]).toMatchObject({
      kind: 'terminal',
      stableId: 's1',
      preset: 'claude',
      x: 10,
      y: 21,
      w: 560,
      h: 380,
      memoryLimitMB: 512,
      walker: false,
    });
    expect(layout.nodes[1]).toMatchObject({ kind: 'note', stableId: 'ns1' });
    expect(layout.edges).toEqual([['s1', 'ns1']]);
    expect(layout.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('tears down terminals and portals when switching layers', async () => {
    withGraphPortals('pp1');
    withLayout(layoutOf([termSpec(), portalSpec()]));
    const { rerender } = renderCanvas({ floorId: 'fl-1', floorLabel: 'One' });
    await flush();
    const t = nodesOf().find((n) => n.type === 'terminal')!;
    const p = nodesOf().find((n) => n.type === 'portal')!;
    // Changing the layer re-runs the load effect: cleanup disposes renderer
    // terminals and unregisters portal graph nodes before loading the new layer.
    rerender(
      <Canvas
        workspaceId="ws-1"
        workspaceCwd="/home/test"
        floorId="fl-2"
        floorLabel="Two"
        isDev={false}
        notifyOnAttention={true}
      />,
    );
    await flush();
    expect(h.terminals.dispose).toHaveBeenCalledWith(t.id);
    expect(window.dw.portalUnregister).toHaveBeenCalledWith(p.id);
    expect(window.dw.loadLayer).toHaveBeenLastCalledWith('ws-1', 'fl-2');
  });

  it('flushes the pending save on unmount', async () => {
    withLayout(layoutOf([termSpec()]));
    const { unmount } = renderCanvas();
    await flush();
    // Render once more post-load so the debounced persist is armed.
    act(() => h.emit('graph', { nodes: [], edges: [] }));
    const before = vi.mocked(window.dw.saveLayer).mock.calls.length;
    act(() => unmount());
    expect(vi.mocked(window.dw.saveLayer).mock.calls.length).toBeGreaterThan(before);
  });
});

describe('rendering degradation ladder (tiers)', () => {
  it('promotes a visible terminal to tier 1 and records it on the node', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    await flush(600); // interval + rAF
    expect(h.terminals.setTier).toHaveBeenCalledWith(id, 1);
    expect(findNode(id).data.tier).toBe(1);
  });

  it('demotes an offscreen terminal to tier 3', async () => {
    withLayout(layoutOf([termSpec({ x: 5000, y: 5000 })]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    await flush(600);
    expect(h.terminals.setTier).toHaveBeenCalledWith(id, 3);
  });

  it('uses tier 2 when zoomed below the readable threshold', async () => {
    h.rf.getViewport.mockReturnValue({ x: 0, y: 0, zoom: 0.3 });
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    await flush(600);
    expect(h.terminals.setTier).toHaveBeenCalledWith(id, 2);
    expect(findNode(id).data.tier).toBe(2);
  });

  it('runs recomputeTiers on every canvas move', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    h.terminals.setTier.mockClear();
    act(() => rfProps().onMove());
    await flush(100);
    expect(h.terminals.setTier.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('recruits, portals and restart', () => {
  it('adopts a recruited teammate beside its walker', async () => {
    withLayout(layoutOf([termSpec({ stableId: 'w1', name: 'Walker', walker: true })]));
    renderCanvas();
    await flush();
    const walker = nodesOf()[0].id;
    act(() =>
      h.emit('recruited', {
        id: 'rec-1',
        stableId: 'rs1',
        name: 'Teammate',
        preset: 'shell',
        roleId: undefined,
        walkerId: walker,
        workspaceId: 'ws-1',
      }),
    );
    await flush();
    expect(window.dw.spawn).toHaveBeenCalledTimes(1); // only the walker
    expect(h.terminals.create).toHaveBeenCalledWith('rec-1');
    const rec = findNode('rec-1');
    expect(rec).toBeDefined();
    expect(rec.data.stableId).toBe('rs1');
    expect(rec.position.x).toBe(0 + 560 + 60);
  });

  it('ignores recruits on other layers', async () => {
    renderCanvas();
    await flush();
    act(() =>
      h.emit('recruited', {
        id: 'rec-1',
        stableId: 'rs1',
        name: 'Teammate',
        preset: 'shell',
        walkerId: 'w',
        workspaceId: 'other-layer',
      }),
    );
    await flush();
    expect(nodesOf()).toHaveLength(0);
  });

  it('removes the node when a recruit is dismissed', async () => {
    withLayout(layoutOf([termSpec({ stableId: 'w1', walker: true })]));
    renderCanvas();
    await flush();
    act(() =>
      h.emit('recruited', {
        id: 'rec-1',
        stableId: 'rs1',
        name: 'Teammate',
        preset: 'shell',
        walkerId: 'term-1',
        workspaceId: 'ws-1',
      }),
    );
    await flush();
    expect(nodesOf()).toHaveLength(2);
    act(() => h.emit('dismissed', 'rec-1'));
    expect(nodesOf()).toHaveLength(1);
    expect(h.terminals.dispose).toHaveBeenCalledWith('rec-1');
  });

  it('relabels a node on reassignment', async () => {
    withLayout(layoutOf([termSpec()]));
    renderCanvas();
    await flush();
    const id = nodesOf()[0].id;
    act(() => h.emit('reassigned', { id, name: 'Renamed' }));
    expect(findNode(id).data.name).toBe('Renamed');
  });

  it('creates a linked portal sharing the source partition on dw:portal-link', async () => {
    withGraphPortals('pp1');
    withLayout(layoutOf([portalSpec({ stableId: 'pp1', url: 'https://a', partition: 'shared' })]));
    renderCanvas();
    await flush();
    act(() => {
      window.dispatchEvent(new CustomEvent('dw:portal-link', { detail: { stableId: 'pp1' } }));
    });
    await flush();
    const portals = nodesOf().filter((n) => n.type === 'portal');
    expect(portals).toHaveLength(2);
    const linked = portals.find((p) => p.id !== 'pp1')!;
    expect(linked.position.x).toBe(0 + 720 + 40);
    expect(linked.data.partition).toBe('shared');
    expect(window.dw.connect).toHaveBeenCalledWith('pp1', linked.data.stableId);
  });

  it('adds a canvas node for an agent-created portal at the viewport center', async () => {
    h.rf.screenToFlowPosition.mockReturnValue({ x: 400, y: 300 });
    renderCanvas();
    await flush();
    act(() => h.emit('portalCreated', { id: 'pc1', name: 'P', url: 'https://p', partition: 'pc1' }));
    await flush();
    expect(window.dw.portalRegister).toHaveBeenCalledWith('pc1', 'P');
    const n = findNode('pc1');
    expect(n.position).toEqual({ x: 40, y: 40 }); // center - size/2
  });

  it('drops stale portal nodes that left the graph', async () => {
    withGraphPortals('pp1');
    withLayout(layoutOf([portalSpec()]));
    renderCanvas();
    await flush();
    expect(nodesOf()).toHaveLength(1);
    act(() => h.emit('graph', { nodes: [], edges: [] }));
    expect(nodesOf()).toHaveLength(0);
  });

  it('restarts an exited terminal in place on dw:terminal-restart', async () => {
    withLayout(layoutOf([termSpec({ stableId: 's1', preset: 'claude', x: 40, y: 50 })]));
    renderCanvas();
    await flush();
    const old = nodesOf()[0].id;
    act(() => {
      window.dispatchEvent(new CustomEvent('dw:terminal-restart', { detail: { id: old } }));
    });
    await flush();
    expect(h.terminals.dispose).toHaveBeenCalledWith(old);
    expect(findNode(old)).toBeUndefined();
    expect(window.dw.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ preset: 'claude', stableId: 's1' }),
    );
    const fresh = nodesOf()[0];
    expect(fresh.id).not.toBe(old);
    expect(fresh.position).toEqual({ x: 40, y: 50 });
    expect(fresh.data.stableId).toBe('s1');
  });
});

describe('dev bar', () => {
  it('renders the DevBar only in dev and spawns 15 terminals on demand', async () => {
    renderCanvas();
    await flush();
    expect(screen.queryByText('Spawn 15')).not.toBeInTheDocument();
    renderCanvas({ isDev: true });
    await flush();
    fireEvent.click(screen.getByText('Spawn 15'));
    await flush();
    expect(window.dw.spawn).toHaveBeenCalledTimes(15);
    expect(nodesOf()).toHaveLength(15);
  });

  it('kill all clears terminals, notes and portals', async () => {
    withGraphPortals('pp1');
    withLayout(layoutOf([termSpec(), noteSpec(), portalSpec()]));
    renderCanvas({ isDev: true });
    await flush();
    const t = nodesOf().find((n) => n.type === 'terminal')!;
    const n = nodesOf().find((x) => x.type === 'note')!;
    const p = nodesOf().find((x) => x.type === 'portal')!;
    fireEvent.click(screen.getByText('Kill all'));
    expect(window.dw.kill).toHaveBeenCalledWith(t.id);
    expect(window.dw.unloadNote).toHaveBeenCalledWith(n.id);
    expect(window.dw.portalUnregister).toHaveBeenCalledWith(p.id);
    expect(h.terminals.dispose).toHaveBeenCalledWith(t.id);
    expect(nodesOf()).toHaveLength(0);
  });

  it('toggles the perf HUD', async () => {
    renderCanvas({ isDev: true });
    await flush();
    expect(document.querySelector('.dw-hud')).toBeNull();
    fireEvent.click(screen.getByText('Perf'));
    expect(document.querySelector('.dw-hud')).not.toBeNull();
    fireEvent.click(screen.getByText('Perf'));
    expect(document.querySelector('.dw-hud')).toBeNull();
  });
});

// ---- query-param-gated e2e harnesses (driven with fake timers) --------------
function harnessResult(query: string, advanceMs: number, marker: string) {
  return async () => {
    window.history.replaceState({}, '', query);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderCanvas();
    await flush(advanceMs);
    expect(log.mock.calls.some((c) => String(c[0]).includes(marker))).toBe(true);
  };
}

describe('query-param harnesses', () => {
  it('smoke harness runs the perf probe', async () => {
    window.history.replaceState({}, '', '/?smoke');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderCanvas();
    await flush(0);
    expect(h.perfProbe.runPerfProbe).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes('SMOKE'))).toBe(false);
  });

  it('palettetest harness clicks a palette chip and reports', harnessResult('/?palettetest', 2500, 'PALETTETEST RESULT'));

  it('attentiontest harness drives attention and clears it', harnessResult('/?attentiontest', 6500, 'ATTENTIONTEST RESULT'));

  it('themetest harness applies a theme and reports', harnessResult('/?themetest', 1500, 'THEMETEST RESULT'));

  it('composertest harness drives the composer round-trip', harnessResult('/?composertest', 5500, 'COMPOSERTEST RESULT'));

  it('notetest harness exercises note CLI verbs and persistence', harnessResult('/?notetest', 9500, 'NOTETEST RESULT'));

  it('persisttest harness saves on first launch', harnessResult('/?persisttest', 2500, 'PERSISTTEST SAVED'));

  it('persisttest harness restores a non-empty layout', async () => {
    window.history.replaceState({}, '', '/?persisttest');
    vi.mocked(window.dw.loadWorkspace).mockResolvedValue({
      id: 'ws-1',
      name: 'ws',
      icon: 'x',
      cwd: '/',
      layout: layoutOf([termSpec(), noteSpec()]),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderCanvas();
    await flush(2500);
    expect(log.mock.calls.some((c) => String(c[0]).includes('PERSISTTEST RESTORED'))).toBe(true);
  });

  it('snaptest harness snaps a live drag', harnessResult('/?snaptest', 2500, 'SNAPTEST RESULT'));

  it('grouptest harness groups, moves and ungroups', harnessResult('/?grouptest', 3500, 'GROUPTEST RESULT'));

  it('fsnodetest harness adds a file tree node', harnessResult('/?fsnodetest', 1500, 'FSNODETEST RESULT'));

  it('fileopstest harness exercises file ops and drag contracts', async () => {
    window.history.replaceState({}, '', '/?fileopstest');
    // A tiny in-memory filesystem so every readDir/rename/remove round-trip in
    // the harness sees realistic entries (the .some assertions then run).
    const fsEntries = new Map<string, Array<{ name: string; isDir: boolean; size: number; mtime: number; path: string }>>();
    const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
    const nameOf = (p: string) => p.split('/').at(-1) ?? '';
    const removeFrom = (p: string) => {
      for (const [, list] of fsEntries) {
        const i = list.findIndex((e) => parentOf(p) === p || `${parentOf(p)}/${e.name}` === p);
        if (i >= 0) list.splice(i, 1);
      }
    };
    vi.mocked(window.dw.createEntry).mockImplementation(async (p: string, isDir: boolean) => {
      const parent = parentOf(p);
      const list = fsEntries.get(parent) ?? [];
      list.push({ name: nameOf(p), isDir, size: 0, mtime: 0, path: p });
      fsEntries.set(parent, list);
      return p;
    });
    vi.mocked(window.dw.removeEntry).mockImplementation(async (p: string) => {
      removeFrom(p);
      fsEntries.delete(p);
    });
    vi.mocked(window.dw.renameEntry).mockImplementation(async (from: string, to: string) => {
      const list = fsEntries.get(parentOf(from)) ?? [];
      const i = list.findIndex((e) => `${parentOf(from)}/${e.name}` === from);
      if (i >= 0) {
        const e = list.splice(i, 1)[0];
        const toParent = parentOf(to);
        const toList = fsEntries.get(toParent) ?? [];
        toList.push({ ...e, name: nameOf(to), path: to });
        fsEntries.set(toParent, toList);
      }
    });
    vi.mocked(window.dw.readDir).mockImplementation(async (p: string) => ({
      path: p,
      entries: fsEntries.get(p) ?? [],
      error: undefined,
    }));
    // The dropped folder resolves as a directory → a File Tree node is born.
    vi.mocked(window.dw.statEntry).mockImplementation(async (p: string) =>
      p.endsWith('/sub')
        ? { name: 'sub', path: p, isDir: true, size: 0, mtime: 0 }
        : null,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderCanvas();
    await flush(5500);
    expect(log.mock.calls.some((c) => String(c[0]).includes('FILEOPSTEST RESULT'))).toBe(true);
  });

  it('editortest harness saves files and mounts CodeMirror', harnessResult('/?editortest', 4500, 'EDITORTEST RESULT'));

  it('searchtest harness exercises fuzzy + file search', harnessResult('/?searchtest', 500, 'SEARCHTEST RESULT'));

  it('imgtest harness stores and deletes a pasted image', harnessResult('/?imgtest', 500, 'IMGTEST RESULT'));

  it('portaltest harness navigates a portal', async () => {
    window.history.replaceState({}, '', '/?portaltest');
    const navs: string[] = [];
    vi.mocked(window.dw.portalNavigate).mockImplementation((_id: string, url: string) => {
      navs.push(url);
    });
    // portalBack is a no-op so the third `until` (waiting for DWPortalOne after
    // going back) times out and takes the fallthrough return path.
    vi.mocked(window.dw.portalBack).mockImplementation(() => {});
    vi.mocked(window.dw.portalState).mockImplementation(async () => {
      const last = navs[navs.length - 1];
      if (!last) return null;
      return {
        url: last,
        title: last.includes('One') ? 'DWPortalOne' : 'DWPortalTwo',
        canGoBack: navs.length > 1,
        canGoForward: false,
      };
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderCanvas();
    await flush(7000);
    expect(log.mock.calls.some((c) => String(c[0]).includes('PORTALTEST RESULT'))).toBe(true);
  });

  it('layouttest harness aligns a live selection', harnessResult('/?layouttest', 2500, 'LAYOUTTEST RESULT'));
});
