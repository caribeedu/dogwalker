/**
 * Characterization tests for App.tsx — the renderer boot shell.
 *
 * Strategy (repo pattern — see Canvas.test.tsx): the heavy children are stubbed
 * (Canvas/Sidebar/Panel/FloorBar render testids and capture their props), the
 * real ReactFlowProvider is replaced by a passthrough (its `key` still forces a
 * subtree remount, which the Canvas stub's mount counter observes),
 * `window.dw` is a fresh stateful Proxy stub per test, and `window.matchMedia`
 * is stubbed (jsdom has none). themeChrome/themes/terminalService stay real:
 * the theme effect's observable output (CSS tokens on <html>, terminals.setTheme)
 * is part of App's contract. The query-param diagnostic harnesses
 * (bgtest/switchtest/sidebartest) are driven with fake timers, asserting on the
 * `... RESULT` console lines they print.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, type ReactNode } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type {
  AppSettings,
  FloorMeta,
  SidebarEntry,
  WorkspaceMeta,
} from '../shared/ipc';
import { BUILTIN_THEMES, type ThemeSpec } from '../shared/themes';
import { terminals } from './terminalService';
import { App } from './App';

const h = vi.hoisted(() => ({
  canvasProps: null as Record<string, unknown> | null,
  sidebarProps: null as Record<string, unknown> | null,
  panelProps: null as Record<string, unknown> | null,
  floorbarProps: null as Record<string, unknown> | null,
  canvasMounts: 0,
  mediaMatches: false,
  mediaListeners: [] as Array<(e: { matches: boolean }) => void>,
  /** Optional transform for the stub canvas's viewport (bgtest camera check). */
  viewportTransform: '',
}));

// ---- child stubs (they have their own test files; App logic is what's tested) --
vi.mock('@xyflow/react', async () => {
  const R = await import('react');
  return {
    ReactFlowProvider: (props: { children?: unknown }) =>
      R.createElement(R.Fragment, null, props.children as ReactNode),
  };
});

vi.mock('./Canvas', async () => {
  const R = await import('react');
  return {
    Canvas: (props: Record<string, unknown>) => {
      h.canvasProps = props;
      // Mount counter: the App keys the provider by workspace:floor, so a
      // switch must remount the canvas subtree (fresh ReactFlow state).
      R.useEffect(() => {
        h.canvasMounts += 1;
      }, []);
      return R.createElement(
        'div',
        {
          'data-testid': 'canvas',
          className: 'react-flow__viewport',
          style: h.viewportTransform ? { transform: h.viewportTransform } : undefined,
        },
        `canvas:${String(props.workspaceId)}:${String(props.floorId)}:${String(
          props.floorLabel,
        )}:${String(props.workspaceCwd)}:${String(props.isDev)}:${String(
          props.notifyOnAttention,
        )}`,
      );
    },
  };
});

vi.mock('./Sidebar', async () => {
  const R = await import('react');
  return {
    Sidebar: (props: Record<string, unknown>) => {
      h.sidebarProps = props;
      const ids = (props.workspaces as WorkspaceMeta[]).map((w) => w.id).join(',');
      return R.createElement(
        'div',
        { 'data-testid': 'sidebar' },
        `sidebar:${ids}:mini=${String(props.mini)}`,
      );
    },
  };
});

vi.mock('./FloorBar', async () => {
  const R = await import('react');
  return {
    FloorBar: (props: Record<string, unknown>) => {
      h.floorbarProps = props;
      const fs = (props.floors as FloorMeta[]).map((f) => f.id).join(',');
      return R.createElement(
        'div',
        { 'data-testid': 'floorbar' },
        `floorbar:${String(props.workspaceId)}:${String(props.activeFloor)}:${fs}`,
      );
    },
  };
});

vi.mock('./Panel', async () => {
  const R = await import('react');
  return {
    Panel: (props: Record<string, unknown>) => {
      h.panelProps = props;
      if (!props.open) return null;
      return R.createElement(
        'div',
        { 'data-testid': 'panel' },
        `panel:${String(props.activeId)}:themes=${(props.themes as ThemeSpec[]).length}`,
      );
    },
  };
});

// ---- fixtures ---------------------------------------------------------------
const wsA: WorkspaceMeta = { id: 'ws-a', name: 'Alpha', icon: '🅰', cwd: '/a' };
const wsB: WorkspaceMeta = { id: 'ws-b', name: 'Beta', icon: '🅱', cwd: '/b' };
const floorF1: FloorMeta = { id: 'f1', name: 'Feature', branch: 'feat/x', path: '/a/f1' };

const customTheme: ThemeSpec = {
  name: 'Custom X',
  appearance: 'dark',
  builtin: false,
  theme: {
    background: '#101020',
    foreground: '#e0e0f0',
    cursor: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    green: '#00ff00',
    yellow: '#ffff00',
    blue: '#0000ff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#ffffff',
    brightBlack: '#333333',
    brightRed: '#ff5555',
    brightGreen: '#55ff55',
    brightYellow: '#ffff55',
    brightBlue: '#5555ff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ffff',
    brightWhite: '#ffffff',
  },
};

const DEFAULT_SETTINGS: AppSettings = {
  themeName: 'Dogwalker Dark',
  lightThemeName: 'GitHub Light',
  followSystem: false,
  notifyOnAttention: true,
  miniSidebar: false,
};

// ---- window.dw stub (stateful so harness round-trips see realistic answers) --
function makeDw() {
  const state: {
    workspaces: WorkspaceMeta[];
    active: string;
    sidebar: SidebarEntry[];
    settings: AppSettings;
    customThemes: ThemeSpec[];
    floors: FloorMeta[];
    activeFloor: string;
    live: Array<{ id: string; stableId: string; name: string; preset: string }>;
    layouts: Record<string, { nodes: unknown[]; edges: unknown[]; viewport?: { x: number; y: number; zoom: number } }>;
  } = {
    workspaces: [wsA, wsB],
    active: 'ws-a',
    sidebar: [
      { kind: 'workspace', id: 'ws-a' },
      { kind: 'workspace', id: 'ws-b' },
    ],
    settings: { ...DEFAULT_SETTINGS },
    customThemes: [],
    floors: [floorF1],
    activeFloor: 'ground',
    live: [{ id: 't1', stableId: 'bgtest-term', name: 'bg', preset: 'shell' }],
    layouts: {},
  };
  let seq = 0;
  const target: Record<string, unknown> = {
    listWorkspaces: vi.fn(async () => ({
      workspaces: state.workspaces,
      active: state.active,
      sidebar: state.sidebar,
    })),
    getSettings: vi.fn(async () => state.settings),
    setSettings: vi.fn(async (partial: Partial<AppSettings>) => {
      state.settings = { ...state.settings, ...partial };
      return state.settings;
    }),
    listCustomThemes: vi.fn(async () => state.customThemes),
    reconcileFloors: vi.fn(async (_wsId: string) => ({
      floors: state.floors,
      active: state.activeFloor,
    })),
    setActiveFloor: vi.fn(async () => undefined),
    setActiveWorkspace: vi.fn(async () => undefined),
    createWorkspace: vi.fn(async (name: string, icon: string) => {
      const ws: WorkspaceMeta = { id: `ws-${++seq}`, name, icon, cwd: `/cwd/${name}` };
      state.workspaces = [...state.workspaces, ws];
      state.sidebar = [...state.sidebar, { kind: 'workspace', id: ws.id }];
      return ws;
    }),
    renameWorkspace: vi.fn(async () => undefined),
    deleteWorkspace: vi.fn(async (id: string) => {
      state.workspaces = state.workspaces.filter((w) => w.id !== id);
      state.sidebar = state.sidebar.filter((e) => e.kind !== 'workspace' || e.id !== id);
      if (state.active === id) state.active = state.workspaces[0]?.id ?? '';
    }),
    hibernateWorkspace: vi.fn(async () => {
      state.live = [];
    }),
    addDivider: vi.fn(async (label: string) => {
      state.sidebar = [...state.sidebar, { kind: 'divider', id: `d${++seq}`, label }];
    }),
    renameDivider: vi.fn(async (id: string, label: string) => {
      state.sidebar = state.sidebar.map((e) =>
        e.kind === 'divider' && e.id === id ? { ...e, label } : e,
      );
    }),
    removeDivider: vi.fn(async (id: string) => {
      state.sidebar = state.sidebar.filter((e) => e.kind !== 'divider' || e.id !== id);
    }),
    reorderSidebar: vi.fn(async (entries: SidebarEntry[]) => {
      state.sidebar = entries;
    }),
    loadWorkspace: vi.fn(async (id: string) => ({
      id,
      name: state.workspaces.find((w) => w.id === id)?.name ?? id,
      icon: 'x',
      cwd: '/',
      layout: state.layouts[id] ?? { nodes: [], edges: [] },
      floors: [],
      activeFloor: 'ground',
    })),
    saveLayout: vi.fn(
      async (
        id: string,
        layout: { nodes: unknown[]; edges: unknown[]; viewport?: { x: number; y: number; zoom: number } },
      ) => {
        state.layouts[id] = layout;
      },
    ),
    listTerminals: vi.fn(async () => state.live),
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
const sidebar = () => h.sidebarProps as unknown as Record<string, any>;
const canvas = () => h.canvasProps as unknown as Record<string, any>;
const panel = () => h.panelProps as unknown as Record<string, any>;
const floorbar = () => h.floorbarProps as unknown as Record<string, any>;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function keydown(key: string, mods: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, bubbles: true, ...mods });
}

function stubMatchMedia() {
  h.mediaListeners = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: h.mediaMatches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
      h.mediaListeners.push(cb);
    },
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// ---- setup ------------------------------------------------------------------
beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/');
  h.canvasProps = null;
  h.sidebarProps = null;
  h.panelProps = null;
  h.floorbarProps = null;
  h.canvasMounts = 0;
  h.mediaMatches = false;
  h.viewportTransform = '';
  stubMatchMedia();
  window.dw = makeDw() as unknown as typeof window.dw;
  vi.clearAllMocks();
  vi.spyOn(terminals, 'setTheme');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

// ---- boot & theme -----------------------------------------------------------
describe('App', () => {
  it('boots: loads workspaces/settings/themes and reconciles floors', async () => {
    render(<App />);
    await flush();
    expect(window.dw.listWorkspaces).toHaveBeenCalled();
    expect(window.dw.getSettings).toHaveBeenCalled();
    expect(window.dw.listCustomThemes).toHaveBeenCalled();
    expect(window.dw.reconcileFloors).toHaveBeenCalledWith('ws-a');
    expect(sidebar().workspaces.map((w: WorkspaceMeta) => w.id)).toEqual(['ws-a', 'ws-b']);
    expect(sidebar().activeId).toBe('ws-a');
    expect(sidebar().mini).toBe(false);
    expect(canvas().workspaceId).toBe('ws-a');
    expect(canvas().floorId).toBe('ground');
    expect(canvas().workspaceCwd).toBe('/a');
    expect(canvas().floorLabel).toBe('ground');
    expect(canvas().isDev).toBe(true);
    expect(canvas().notifyOnAttention).toBe(true);
    expect(floorbar().workspaceId).toBe('ws-a');
    expect(floorbar().floors.map((f: FloorMeta) => f.id)).toEqual(['f1']);
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('applies the built-in theme chrome on boot', async () => {
    render(<App />);
    await flush();
    expect(terminals.setTheme).toHaveBeenCalledWith(BUILTIN_THEMES[0].theme);
    expect(document.documentElement.dataset.appTheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--dw-bg')).toBe('#16161c');
  });

  it('loads custom themes from disk and applies a selected custom theme', async () => {
    vi.mocked(window.dw.listCustomThemes).mockResolvedValue([customTheme]);
    vi.mocked(window.dw.getSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      themeName: 'Custom X',
    });
    render(<App />);
    await flush();
    expect(terminals.setTheme).toHaveBeenCalledWith(customTheme.theme);
    expect(document.documentElement.dataset.appTheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--dw-bg')).toBe('#101020');
    // The custom theme joins the built-ins in the gallery.
    expect(panel().themes.length).toBe(BUILTIN_THEMES.length + 1);
    expect(panel().themes.at(-1).name).toBe('Custom X');
    expect(panel().activeThemeName).toBe('Custom X');
  });

  it('follows the OS light/dark scheme when followSystem is on', async () => {
    render(<App />);
    await flush();
    // osDark=false (stub) → the light theme applies.
    await act(async () => {
      panel().onUpdateSettings({ followSystem: true });
    });
    await flush();
    const light = BUILTIN_THEMES.find((t) => t.name === 'GitHub Light')!;
    expect(terminals.setTheme).toHaveBeenLastCalledWith(light.theme);
    expect(document.documentElement.dataset.appTheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--dw-bg')).toBe('#ffffff');
    // OS flips to dark → the main theme applies.
    act(() => {
      h.mediaMatches = true;
      for (const cb of h.mediaListeners) cb({ matches: true });
    });
    await flush();
    const dark = BUILTIN_THEMES.find((t) => t.name === 'Dogwalker Dark')!;
    expect(terminals.setTheme).toHaveBeenLastCalledWith(dark.theme);
    expect(document.documentElement.dataset.appTheme).toBe('dark');
  });

  it('falls back to the main theme when the light theme name is unknown', async () => {
    vi.mocked(window.dw.getSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      themeName: 'Nord',
      lightThemeName: 'No Such Theme',
      followSystem: true,
    });
    // OS light (default stub) → the missing light theme is picked, so the
    // resolve falls back to the main theme.
    render(<App />);
    await flush();
    const nord = BUILTIN_THEMES.find((t) => t.name === 'Nord')!;
    expect(terminals.setTheme).toHaveBeenLastCalledWith(nord.theme);
    expect(document.documentElement.style.getPropertyValue('--dw-bg')).toBe('#2e3440');
  });

  it('falls back to the first built-in theme when the theme name is unknown', async () => {
    vi.mocked(window.dw.getSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      themeName: 'No Such Theme',
    });
    render(<App />);
    await flush();
    expect(terminals.setTheme).toHaveBeenLastCalledWith(BUILTIN_THEMES[0].theme);
    expect(document.documentElement.dataset.appTheme).toBe('dark');
    expect(panel().activeThemeName).toBe('Dogwalker Dark');
  });

  // ---- workspace switching ---------------------------------------------------
  it('switches workspaces through the sidebar and remounts the canvas', async () => {
    render(<App />);
    await flush();
    expect(h.canvasMounts).toBe(1);
    act(() => sidebar().onSwitch('ws-b'));
    await flush();
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-b');
    expect(sidebar().activeId).toBe('ws-b');
    expect(canvas().workspaceId).toBe('ws-b');
    expect(canvas().floorId).toBe('ground');
    expect(canvas().workspaceCwd).toBe('/b');
    expect(window.dw.reconcileFloors).toHaveBeenCalledWith('ws-b');
    expect(h.canvasMounts).toBe(2);
  });

  it('reconciles the active id when the current workspace disappears', async () => {
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [wsB],
      active: 'ws-b',
      sidebar: [{ kind: 'workspace', id: 'ws-b' }],
    });
    render(<App />);
    await flush();
    expect(sidebar().activeId).toBe('ws-b');
    expect(canvas().workspaceId).toBe('ws-b');
  });

  it('falls back to an empty cwd when the active workspace is missing', async () => {
    // main points at a workspace that is not in the returned list — the
    // canvas still mounts (activeId is set) with an empty cwd.
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [wsB],
      active: 'ws-a',
      sidebar: [{ kind: 'workspace', id: 'ws-a' }],
    });
    render(<App />);
    await flush();
    expect(canvas().workspaceId).toBe('ws-a');
    expect(canvas().workspaceCwd).toBe('');
  });

  it('creates a workspace from the sidebar and switches to it', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onCreate());
    await flush();
    expect(window.dw.createWorkspace).toHaveBeenCalledWith('New workspace', '');
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-1');
    expect(canvas().workspaceId).toBe('ws-1');
    expect(window.dw.reconcileFloors).toHaveBeenCalledWith('ws-1');
  });

  it('creates a workspace from the panel', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onOpenMenu());
    await flush();
    act(() => panel().onCreate());
    await flush();
    expect(window.dw.createWorkspace).toHaveBeenCalledWith('New workspace', '');
    expect(canvas().workspaceId).toBe('ws-1');
  });

  it('renames a workspace', async () => {
    render(<App />);
    await flush();
    act(() => panel().onRename('ws-a', 'Renamed', 'R', '/r'));
    await flush();
    expect(window.dw.renameWorkspace).toHaveBeenCalledWith('ws-a', 'Renamed', 'R', '/r');
    expect(window.dw.listWorkspaces).toHaveBeenCalled();
  });

  it('deletes the active workspace and switches to the new active', async () => {
    render(<App />);
    await flush();
    act(() => panel().onDelete('ws-a'));
    await flush();
    expect(window.dw.deleteWorkspace).toHaveBeenCalledWith('ws-a');
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-b');
    expect(canvas().workspaceId).toBe('ws-b');
  });

  it('deletes a non-active workspace without switching', async () => {
    render(<App />);
    await flush();
    act(() => panel().onDelete('ws-b'));
    await flush();
    expect(window.dw.deleteWorkspace).toHaveBeenCalledWith('ws-b');
    expect(window.dw.setActiveWorkspace).not.toHaveBeenCalled();
    expect(canvas().workspaceId).toBe('ws-a');
  });

  it('hibernates a workspace', async () => {
    render(<App />);
    await flush();
    act(() => panel().onHibernate('ws-a'));
    await flush();
    expect(window.dw.hibernateWorkspace).toHaveBeenCalledWith('ws-a');
  });

  // ---- floors ----------------------------------------------------------------
  it('switches floors and passes the floor path/label to the canvas', async () => {
    render(<App />);
    await flush();
    act(() => floorbar().onSwitch('f1'));
    await flush();
    expect(window.dw.setActiveFloor).toHaveBeenCalledWith('ws-a', 'f1');
    expect(canvas().floorId).toBe('f1');
    expect(canvas().workspaceCwd).toBe('/a/f1');
    expect(canvas().floorLabel).toBe('Feature');
    expect(floorbar().activeFloor).toBe('f1');
    expect(h.canvasMounts).toBe(2);
  });

  it('falls back to the active floor when the current floor vanishes', async () => {
    render(<App />);
    await flush();
    act(() => floorbar().onSwitch('f1'));
    await flush();
    vi.mocked(window.dw.reconcileFloors).mockResolvedValue({ floors: [], active: 'ground' });
    act(() => floorbar().onChanged());
    await flush();
    expect(canvas().floorId).toBe('ground');
    expect(canvas().floorLabel).toBe('ground');
    expect(canvas().workspaceCwd).toBe('/a');
  });

  it('falls back to the raw floor id when the floor is missing from the list', async () => {
    render(<App />);
    await flush();
    // A floor the App has never seen: label/cwd fall back to the id / ''.
    act(() => floorbar().onSwitch('ghost'));
    await flush();
    expect(canvas().floorId).toBe('ghost');
    expect(canvas().floorLabel).toBe('ghost');
    expect(canvas().workspaceCwd).toBe('');
  });

  it('keeps the current floor when it survives a reconcile', async () => {
    render(<App />);
    await flush();
    act(() => floorbar().onSwitch('f1'));
    await flush();
    vi.mocked(window.dw.reconcileFloors).mockResolvedValue({ floors: [floorF1], active: 'ground' });
    act(() => floorbar().onChanged());
    await flush();
    expect(canvas().floorId).toBe('f1');
  });

  it('ground floor yields to the reconciled active floor', async () => {
    render(<App />);
    await flush();
    vi.mocked(window.dw.reconcileFloors).mockResolvedValue({ floors: [], active: 'f9' });
    act(() => floorbar().onChanged());
    await flush();
    // On ground the `cur !== 'ground'` guard is false, so the reconcile's
    // `active` answer wins outright (normally 'ground', keeping the ground
    // floor stable — here the stub reports a floor to surface the branch).
    expect(canvas().floorId).toBe('f9');
  });

  // ---- panel & settings ------------------------------------------------------
  it('opens and closes the panel', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onOpenMenu());
    await flush();
    expect(panel().open).toBe(true);
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(panel().themes.length).toBe(BUILTIN_THEMES.length);
    expect(panel().activeThemeName).toBe('Dogwalker Dark');
    act(() => panel().onClose());
    await flush();
    expect(panel().open).toBe(false);
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('switches workspace from the panel and closes it', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onOpenMenu());
    await flush();
    act(() => panel().onSwitch('ws-b'));
    await flush();
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-b');
    expect(panel().open).toBe(false);
    expect(canvas().workspaceId).toBe('ws-b');
  });

  it('toggles the mini sidebar from the rail', async () => {
    render(<App />);
    await flush();
    expect(sidebar().mini).toBe(false);
    act(() => sidebar().onToggleMini());
    await flush();
    expect(window.dw.setSettings).toHaveBeenCalledWith({ miniSidebar: true });
    expect(sidebar().mini).toBe(true);
  });

  // ---- sidebar ops -----------------------------------------------------------
  it('adds a divider', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onAddDivider());
    await flush();
    expect(window.dw.addDivider).toHaveBeenCalledWith('Section');
    expect(window.dw.listWorkspaces).toHaveBeenCalled();
  });

  it('renames a divider', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onRenameDivider('d1', 'Docs'));
    await flush();
    expect(window.dw.renameDivider).toHaveBeenCalledWith('d1', 'Docs');
  });

  it('removes a divider', async () => {
    render(<App />);
    await flush();
    act(() => sidebar().onRemoveDivider('d1'));
    await flush();
    expect(window.dw.removeDivider).toHaveBeenCalledWith('d1');
  });

  it('reorders the sidebar optimistically and persists', async () => {
    render(<App />);
    await flush();
    const entries: SidebarEntry[] = [
      { kind: 'workspace', id: 'ws-b' },
      { kind: 'divider', id: 'dx', label: 'X' },
      { kind: 'workspace', id: 'ws-a' },
    ];
    act(() => sidebar().onReorder(entries));
    await flush();
    expect(window.dw.reorderSidebar).toHaveBeenCalledWith(entries);
    // Optimistic update then reconciled from the store.
    expect(sidebar().sidebar.map((e: SidebarEntry) => e.id)).toEqual(['ws-b', 'dx', 'ws-a']);
  });

  // ---- keyboard shortcuts ----------------------------------------------------
  it('Ctrl+number jumps to a workspace', async () => {
    render(<App />);
    await flush();
    keydown('1', { ctrlKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-a');
    keydown('2', { ctrlKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-b');
  });

  it('Ctrl+Alt+arrows step between workspaces with wrap-around', async () => {
    render(<App />);
    await flush();
    keydown('ArrowRight', { ctrlKey: true, altKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-b');
    keydown('ArrowLeft', { ctrlKey: true, altKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-a');
    // Wrap forward from the last workspace back to the first.
    act(() => sidebar().onSwitch('ws-b'));
    await flush();
    keydown('ArrowRight', { ctrlKey: true, altKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledWith('ws-a');
  });

  it('ignores keydown without the right modifiers or an in-range number', async () => {
    render(<App />);
    await flush();
    keydown('1'); // no modifier
    keydown('1', { ctrlKey: true, shiftKey: true }); // shift blocks
    keydown('ArrowDown', { ctrlKey: true, altKey: true }); // alt but wrong arrow
    keydown('0', { ctrlKey: true }); // out of range
    keydown('9', { ctrlKey: true }); // beyond the workspace count
    keydown('Escape', { ctrlKey: true }); // not a digit
    expect(window.dw.setActiveWorkspace).not.toHaveBeenCalled();
  });

  it('does nothing when there are no workspaces', async () => {
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [],
      active: '',
      sidebar: [],
    });
    render(<App />);
    await flush();
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    expect(screen.queryByTestId('floorbar')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(window.dw.reconcileFloors).not.toHaveBeenCalled();
    keydown('1', { ctrlKey: true });
    expect(window.dw.setActiveWorkspace).not.toHaveBeenCalled();
  });

  it('removes the keydown listener on unmount', async () => {
    const { unmount } = render(<App />);
    await flush();
    keydown('2', { ctrlKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledTimes(1);
    unmount();
    keydown('2', { ctrlKey: true });
    expect(window.dw.setActiveWorkspace).toHaveBeenCalledTimes(1);
  });

  // ---- query-param diagnostic harnesses --------------------------------------
  it('sidebartest harness reports sections, reorder and divider round-trip', async () => {
    window.history.replaceState({}, '', '/?sidebartest');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await flush();
    await flush();
    expect(log.mock.calls.some((c) => String(c[0]).includes('SIDEBARTEST RESULT'))).toBe(true);
    expect(window.dw.addDivider).toHaveBeenCalledWith('SIDEBARTEST');
    expect(window.dw.removeDivider).toHaveBeenCalled();
    expect(window.dw.reorderSidebar).toHaveBeenCalledTimes(2);
  });

  it('sidebartest harness tolerates a divider-only rail', async () => {
    // No workspace entry and no matching divider: the guarded store sections
    // (dividerAdded / reorder / remove) all take their fallback paths.
    window.history.replaceState({}, '', '/?sidebartest');
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [],
      active: '',
      sidebar: [{ kind: 'divider', id: 'x', label: 'Work' }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await flush();
    await flush();
    expect(log.mock.calls.some((c) => String(c[0]).includes('SIDEBARTEST RESULT'))).toBe(true);
    expect(window.dw.removeDivider).not.toHaveBeenCalled();
    expect(window.dw.reorderSidebar).toHaveBeenCalledTimes(1); // restore only
  });

  it('sidebartest harness is guarded against a double effect run', async () => {
    window.history.replaceState({}, '', '/?sidebartest');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await flush();
    await flush();
    const hits = log.mock.calls.filter((c) => String(c[0]).includes('SIDEBARTEST RESULT'));
    expect(hits).toHaveLength(1);
  });

  it('bgtest harness reports the background-workspace round trip', async () => {
    window.history.replaceState({}, '', '/?bgtest');
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [wsA],
      active: 'ws-a',
      sidebar: [{ kind: 'workspace', id: 'ws-a' }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await flush(20000);
    await flush();
    expect(log.mock.calls.some((c) => String(c[0]).includes('BGTEST RESULT'))).toBe(true);
    expect(window.dw.createWorkspace).toHaveBeenCalledWith('bgtest-B', '🧪');
    expect(window.dw.deleteWorkspace).toHaveBeenCalled();
  });

  it('bgtest harness reuses the second workspace when one exists', async () => {
    window.history.replaceState({}, '', '/?bgtest');
    h.viewportTransform = 'translate(-300px, -150px) scale(0.75)';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await flush(20000);
    await flush();
    // With 2 workspaces no createWorkspace/deleteWorkspace happens, and the
    // stub viewport transform lets the camera-restored check fully evaluate.
    expect(log.mock.calls.some((c) => String(c[0]).includes('BGTEST RESULT'))).toBe(true);
    expect(window.dw.createWorkspace).not.toHaveBeenCalled();
    expect(window.dw.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('bgtest harness is guarded against a double effect run', async () => {
    window.history.replaceState({}, '', '/?bgtest');
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [wsA],
      active: 'ws-a',
      sidebar: [{ kind: 'workspace', id: 'ws-a' }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await flush(20000);
    await flush();
    const hits = log.mock.calls.filter((c) => String(c[0]).includes('BGTEST RESULT'));
    expect(hits).toHaveLength(1);
  });

  it('switchtest harness reports the A→B→A camera round trip', async () => {
    window.history.replaceState({}, '', '/?switchtest');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await flush(20000);
    await flush();
    expect(log.mock.calls.some((c) => String(c[0]).includes('SWITCHTEST'))).toBe(true);
    // Two workspaces already exist → no createWorkspace fallback.
    expect(window.dw.createWorkspace).not.toHaveBeenCalled();
  });

  it('switchtest harness creates a second workspace when only one exists', async () => {
    window.history.replaceState({}, '', '/?switchtest');
    vi.mocked(window.dw.listWorkspaces).mockResolvedValue({
      workspaces: [wsA],
      active: 'ws-a',
      sidebar: [{ kind: 'workspace', id: 'ws-a' }],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<App />);
    await flush(20000);
    await flush();
    expect(log.mock.calls.some((c) => String(c[0]).includes('SWITCHTEST'))).toBe(true);
    expect(window.dw.createWorkspace).toHaveBeenCalledWith('switch-B', '🧪');
  });

  it('switchtest harness is guarded against a double effect run', async () => {
    window.history.replaceState({}, '', '/?switchtest');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await flush(20000);
    await flush();
    const hits = log.mock.calls.filter((c) => String(c[0]).includes('SWITCHTEST'));
    expect(hits).toHaveLength(1);
  });
});
