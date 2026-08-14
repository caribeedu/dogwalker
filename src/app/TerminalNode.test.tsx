import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import type { TerminalFlowNode } from './TerminalNode';
import { TerminalNode } from './TerminalNode';
import { DW_FILE_MIME } from './dnd';

// Shared spies (hoisted so the vi.mock factories below can close over them):
// React Flow's delete/update paths, and the terminal service facade (xterm
// needs a real DOM/canvas; jsdom can't drive it, so the component's use of
// terminals.attach/onInput/fit/dispose is asserted against spies instead).
const h = vi.hoisted(() => ({
  deleteElements: vi.fn(),
  updateNodeData: vi.fn(),
  terminals: {
    attach: vi.fn(),
    onInput: vi.fn(),
    fit: vi.fn(),
    dispose: vi.fn(),
  },
}));

// TerminalNode renders Handle/Position from React Flow; without a provider
// context the real Handle would throw. Stub the whole module like the repo's
// other node tests do, and keep delete/update on spies.
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  useReactFlow: () => ({
    deleteElements: h.deleteElements,
    updateNodeData: h.updateNodeData,
  }),
}));

vi.mock('./terminalService', () => ({ terminals: h.terminals }));

// jsdom has no ResizeObserver. The fake records every instance (with its
// callback) so tests can fire the resize path and assert cleanup.
interface ResizeInstance {
  callback: () => void;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
const resizeInstances: ResizeInstance[] = [];

class FakeResizeObserver {
  callback: () => void;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(cb: () => void) {
    this.callback = cb;
    resizeInstances.push(this);
  }
}

function makePreset(id: string, name: string) {
  return { id, name, icon: 'x', command: 'echo hi', builtin: false };
}

// jsdom 30 does not expose the DataTransfer constructor; a plain object with
// the same surface (types/getData/setData/dropEffect) is enough for React's
// synthetic drag events to carry the file path.
function makeDataTransfer(entries: Record<string, string> = {}): DataTransfer {
  return {
    types: Object.keys(entries),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    items: [],
    files: [],
    setData: (type: string, value: string) => {
      entries[type] = value;
    },
    getData: (type: string) => entries[type] ?? '',
    clearData: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

function baseData(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'shell',
    preset: 'preset-a',
    tier: 2,
    exited: false,
    stableId: 's1',
    ...overrides,
  };
}

function renderTerminal(overrides: Partial<Record<string, unknown>> = {}) {
  const props = {
    id: 't1',
    data: baseData(),
    selected: false,
    ...overrides,
  } as unknown as NodeProps<TerminalFlowNode>;
  return render(<TerminalNode {...props} />);
}

/** Drain the effect's listPresets/listRoles microtask inside act(). */
const flush = () => act(async () => {});

describe('TerminalNode', () => {
  beforeEach(() => {
    resizeInstances.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.resetAllMocks();
    window.dw = {
      setWalker: vi.fn(),
      listPresets: vi.fn().mockResolvedValue([]),
      listRoles: vi.fn().mockResolvedValue([]),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      assignTerminalRole: vi.fn().mockResolvedValue(''),
    } as unknown as typeof window.dw;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the terminal name and its tier badge', async () => {
    const { container } = renderTerminal();
    await flush();
    expect(screen.getByText('shell')).toBeInTheDocument();
    // import.meta.env.DEV is on in vitest, so the badge is rendered.
    expect(container.querySelector('.dw-tier')?.textContent).toBe('DOM');
  });

  it('renders a tier badge for every tier', async () => {
    for (const [tier, label] of [
      [1, 'GL'],
      [2, 'DOM'],
      [3, 'ZZZ'],
    ] as const) {
      const { container } = renderTerminal({ data: baseData({ tier }) });
      await flush();
      expect(container.querySelector('.dw-tier')?.textContent).toBe(label);
    }
  });

  it('shows attention and walker markers when set', async () => {
    renderTerminal({ data: baseData({ attention: true, walker: true }) });
    await flush();
    expect(screen.getByTitle('Needs attention')).toBeInTheDocument();
    expect(screen.getByTitle('Walker')).toBeInTheDocument();
  });

  it('hides attention and walker markers when unset', async () => {
    renderTerminal();
    await flush();
    expect(screen.queryByTitle('Needs attention')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Walker')).not.toBeInTheDocument();
  });

  it('marks the node as selected', async () => {
    const { container } = renderTerminal({ selected: true });
    await flush();
    expect(container.querySelector('.dw-node')?.className).toContain('dw-node-selected');
  });

  it('shows the exited marker and dispatches a restart event', async () => {
    const listener = vi.fn();
    window.addEventListener('dw:terminal-restart', listener);
    try {
      renderTerminal({ data: baseData({ exited: true }) });
      await flush();
      expect(screen.getByText(/shell · exited/)).toBeInTheDocument();
      fireEvent.click(screen.getByTitle('Restart this terminal'));
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 't1' });
    } finally {
      window.removeEventListener('dw:terminal-restart', listener);
    }
  });

  it('hides the restart button while the terminal is running', async () => {
    renderTerminal();
    await flush();
    expect(screen.queryByTitle('Restart this terminal')).not.toBeInTheDocument();
  });

  it('toggles the walker flag on and off', async () => {
    renderTerminal();
    await flush();
    fireEvent.click(screen.getByTitle('Make this a Walker (manager agent)'));
    expect(h.updateNodeData).toHaveBeenCalledWith('t1', { walker: true });
    expect(window.dw.setWalker).toHaveBeenCalledWith('t1', true);

    renderTerminal({ data: baseData({ walker: true }) });
    await flush();
    fireEvent.click(screen.getByTitle('Walker (manages a team) — click to unset'));
    expect(h.updateNodeData).toHaveBeenCalledWith('t1', { walker: false });
    expect(window.dw.setWalker).toHaveBeenCalledWith('t1', false);
  });

  it('lists presets and switches the terminal preset', async () => {
    vi.mocked(window.dw.listPresets).mockResolvedValue([
      makePreset('preset-a', 'Alpha'),
      makePreset('preset-b', 'Beta'),
    ]);
    renderTerminal();
    await flush();
    const select = screen.getByTitle(
      'Terminal preset — changes apply on restart',
    ) as HTMLSelectElement;
    expect(select.value).toBe('preset-a');
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'preset-b' } });
    expect(h.updateNodeData).toHaveBeenCalledWith('t1', { preset: 'preset-b' });
  });

  it('flags a missing preset and offers a replacement option', async () => {
    vi.mocked(window.dw.listPresets).mockResolvedValue([makePreset('preset-a', 'Alpha')]);
    renderTerminal({ data: baseData({ preset: 'gone' }) });
    await flush();
    const select = screen.getByTitle(
      'Missing preset — choose a replacement; it is used on restart',
    ) as HTMLSelectElement;
    expect(select.className).toContain('missing');
    expect(select.value).toBe('gone');
    expect(screen.getByText('missing preset')).toBeInTheDocument();
  });

  it('refreshes the preset list on dw:presets-changed', async () => {
    vi.mocked(window.dw.listPresets).mockResolvedValue([makePreset('preset-a', 'Alpha')]);
    renderTerminal();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument(),
    );
    expect(window.dw.listPresets).toHaveBeenCalledTimes(1);

    vi.mocked(window.dw.listPresets).mockResolvedValue([makePreset('preset-b', 'Beta')]);
    window.dispatchEvent(new Event('dw:presets-changed'));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument(),
    );
    expect(window.dw.listPresets).toHaveBeenCalledTimes(2);
  });

  it('lists roles and assigns one', async () => {
    vi.mocked(window.dw.listRoles).mockResolvedValue([
      { id: 'role-a', name: 'Alpha Role', instructions: '' },
    ]);
    renderTerminal();
    await flush();
    const select = screen.getByTitle('Assign role') as HTMLSelectElement;
    expect(screen.getByRole('option', { name: 'Alpha Role' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'role-a' } });
    expect(h.updateNodeData).toHaveBeenCalledWith('t1', { roleId: 'role-a' });
    expect(window.dw.assignTerminalRole).toHaveBeenCalledWith('t1', 'role-a');
  });

  it('clears the role assignment by selecting the empty option', async () => {
    vi.mocked(window.dw.listRoles).mockResolvedValue([
      { id: 'role-a', name: 'Alpha Role', instructions: '' },
    ]);
    renderTerminal({ data: baseData({ roleId: 'role-a' }) });
    await flush();
    fireEvent.change(screen.getByTitle('Assign role'), { target: { value: '' } });
    expect(h.updateNodeData).toHaveBeenCalledWith('t1', { roleId: undefined });
    expect(window.dw.assignTerminalRole).toHaveBeenCalledWith('t1', undefined);
  });

  it('flags a missing role and offers a replacement', async () => {
    vi.mocked(window.dw.listRoles).mockResolvedValue([
      { id: 'role-a', name: 'Alpha Role', instructions: '' },
    ]);
    renderTerminal({ data: baseData({ roleId: 'gone-role' }) });
    await flush();
    const select = screen.getByTitle('Missing role — select a replacement') as HTMLSelectElement;
    expect(select.className).toContain('missing');
    expect(select.value).toBe('gone-role');
    expect(screen.getAllByText('missing role')).toHaveLength(2);
  });

  it('refreshes the role list on dw:roles-changed', async () => {
    vi.mocked(window.dw.listRoles).mockResolvedValue([
      { id: 'role-a', name: 'Alpha Role', instructions: '' },
    ]);
    renderTerminal();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Alpha Role' })).toBeInTheDocument(),
    );
    expect(window.dw.listRoles).toHaveBeenCalledTimes(1);

    vi.mocked(window.dw.listRoles).mockResolvedValue([
      { id: 'role-b', name: 'Beta Role', instructions: '' },
    ]);
    window.dispatchEvent(new Event('dw:roles-changed'));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Beta Role' })).toBeInTheDocument(),
    );
    expect(window.dw.listRoles).toHaveBeenCalledTimes(2);
  });

  it('marks drop-over only for dogwalker file drags and clears on leave', async () => {
    const { container } = renderTerminal();
    await flush();
    const node = container.querySelector('.dw-node')!;

    const ours = makeDataTransfer({ [DW_FILE_MIME]: '/abs/f.txt' });
    fireEvent.dragOver(node, { dataTransfer: ours });
    expect(node.className).toContain('dw-drop-over');
    expect(ours.dropEffect).toBe('copy');

    fireEvent.dragLeave(node);
    expect(node.className).not.toContain('dw-drop-over');

    const foreign = makeDataTransfer({ 'text/plain': 'nope' });
    fireEvent.dragOver(node, { dataTransfer: foreign });
    expect(node.className).not.toContain('dw-drop-over');
  });

  it('types a dropped file path into the terminal', async () => {
    const { container } = renderTerminal();
    await flush();
    const node = container.querySelector('.dw-node')!;

    const dt = makeDataTransfer({ [DW_FILE_MIME]: '/abs/file.txt' });
    fireEvent.dragOver(node, { dataTransfer: dt });
    expect(node.className).toContain('dw-drop-over');
    fireEvent.drop(node, { dataTransfer: dt });
    expect(node.className).not.toContain('dw-drop-over');
    expect(window.dw.write).toHaveBeenCalledWith('t1', '/abs/file.txt ');
  });

  it('quotes dropped paths that contain spaces', async () => {
    const { container } = renderTerminal();
    await flush();
    const dt = makeDataTransfer({ [DW_FILE_MIME]: '/abs/my file.txt' });
    fireEvent.drop(container.querySelector('.dw-node')!, { dataTransfer: dt });
    expect(window.dw.write).toHaveBeenCalledWith('t1', '"/abs/my file.txt" ');
  });

  it('ignores drops without a dogwalker file', async () => {
    const { container } = renderTerminal();
    await flush();
    const dt = makeDataTransfer({ 'text/plain': '/abs/foreign.txt' });
    fireEvent.drop(container.querySelector('.dw-node')!, { dataTransfer: dt });
    expect(window.dw.write).not.toHaveBeenCalled();
  });

  it('closes and disposes the terminal', async () => {
    renderTerminal();
    await flush();
    fireEvent.click(screen.getByTitle('Close terminal'));
    expect(window.dw.kill).toHaveBeenCalledWith('t1');
    expect(h.terminals.dispose).toHaveBeenCalledWith('t1');
    expect(h.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: 't1' }] });
  });

  it('attaches the terminal body and forwards input to window.dw.write', async () => {
    renderTerminal();
    await flush();
    expect(h.terminals.attach).toHaveBeenCalledWith('t1', expect.any(HTMLElement));
    const body = h.terminals.attach.mock.calls[0][1] as HTMLElement;
    expect(body.className).toContain('dw-term-body');
    expect(h.terminals.onInput).toHaveBeenCalledWith('t1', expect.any(Function));
    const onInput = h.terminals.onInput.mock.calls[0][1] as (input: string) => void;
    onInput('echo hi');
    expect(window.dw.write).toHaveBeenCalledWith('t1', 'echo hi');
  });

  it('resizes the terminal after the body resizes, debounced', async () => {
    h.terminals.fit.mockReturnValue({ cols: 80, rows: 24 });
    renderTerminal();
    await flush();
    const ro = resizeInstances.at(-1)!;
    expect(ro.observe).toHaveBeenCalledTimes(1);
    ro.callback();
    ro.callback(); // second observation within the debounce window is dropped
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.terminals.fit).toHaveBeenCalledTimes(1);
    expect(window.dw.resize).toHaveBeenCalledWith('t1', 80, 24);

    ro.callback();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.terminals.fit).toHaveBeenCalledTimes(2);
    expect(window.dw.resize).toHaveBeenCalledTimes(2);
  });

  it('skips resizing when the terminal reports no dims', async () => {
    h.terminals.fit.mockReturnValue(null);
    renderTerminal();
    await flush();
    resizeInstances.at(-1)!.callback();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.terminals.fit).toHaveBeenCalledTimes(1);
    expect(window.dw.resize).not.toHaveBeenCalled();
  });

  it('disconnects the observer and drops pending work on unmount', async () => {
    const { unmount } = renderTerminal();
    await flush();
    const ro = resizeInstances.at(-1)!;
    ro.callback(); // schedules a debounced resize
    unmount();
    expect(ro.disconnect).toHaveBeenCalled();

    window.dispatchEvent(new Event('dw:presets-changed'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(window.dw.resize).not.toHaveBeenCalled();
    // The preset listener was torn down: the event must not trigger a refetch.
    expect(window.dw.listPresets).toHaveBeenCalledTimes(1);
  });
});
