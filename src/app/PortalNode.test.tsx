import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import type { PortalFlowNode } from './PortalNode';
import { PortalNode } from './PortalNode';

const h = vi.hoisted(() => ({
  deleteElements: vi.fn(),
  transform: [0, 0, 1] as number[],
}));

// PortalNode only uses React Flow chrome primitives (resizer, handles,
// deleteElements, canvas transform) — none need the real store in jsdom.
// `transform` stays mutable so tests can re-render with a new zoom and
// exercise the bounds-sync effect's `[stableId, transform]` dependency.
vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  useReactFlow: () => ({ deleteElements: h.deleteElements }),
  useStore: (sel: (s: { transform: number[] }) => unknown) => sel({ transform: h.transform }),
}));

// portalOcclusion is characterized separately in portalOcclusion.test.ts; here
// we mock it so tests control the clip geometry (jsdom rects are all 0×0, so
// the real module could never produce a visible clip) and can drive re-clip
// cycles through the captured observer listener.
const occ = vi.hoisted(() => ({
  clipToOccluders: vi.fn(),
  observeOcclusion: vi.fn(),
}));

vi.mock('./portalOcclusion', () => occ);

interface NavEvent {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let navListener: ((e: NavEvent) => void) | undefined;
let offNav: (() => void) | undefined;
let occlusionListener: ((holes: Rect[]) => void) | undefined;

// jsdom ships no ResizeObserver; the fake records the callback so tests can
// fire it and proves the component wires observe/disconnect on mount/unmount.
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  callback: () => void;

  constructor(cb: () => void) {
    this.callback = cb;
    ResizeObserverStub.instances.push(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderPortal(overrides: Partial<Record<string, unknown>> = {}) {
  const props = {
    id: 'p1',
    data: { name: 'Web', stableId: 's1', url: 'https://dogwalker.dev', partition: 'persist:dw' },
    selected: false,
    ...overrides,
  } as unknown as NodeProps<PortalFlowNode>;
  return render(<PortalNode {...props} />);
}

describe('PortalNode', () => {
  beforeEach(() => {
    h.deleteElements.mockClear();
    h.transform = [0, 0, 1];
    navListener = undefined;
    offNav = undefined;
    occlusionListener = undefined;
    ResizeObserverStub.instances.length = 0;

    occ.clipToOccluders.mockClear();
    occ.clipToOccluders.mockReturnValue({ x: 0, y: 0, width: 100, height: 80 });
    occ.observeOcclusion.mockClear();
    occ.observeOcclusion.mockImplementation((listener: (holes: Rect[]) => void) => {
      occlusionListener = listener;
      return () => {};
    });

    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    window.dw = {
      portalCreate: vi.fn(),
      onPortalNav: vi.fn((cb: (e: NavEvent) => void) => {
        navListener = cb;
        offNav = vi.fn();
        return offNav;
      }),
      portalDestroy: vi.fn(),
      portalSetBounds: vi.fn(),
      portalNavigate: vi.fn(),
      portalUnregister: vi.fn(),
      portalBack: vi.fn(),
      portalForward: vi.fn(),
      portalReload: vi.fn(),
    } as unknown as typeof window.dw;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates the portal and aligns its native bounds on mount', () => {
    renderPortal();
    expect(window.dw.portalCreate).toHaveBeenCalledWith('s1', 'persist:dw', 'https://dogwalker.dev');
    // jsdom gives 0×0 body rects, so the mocked clip returns the 100×80 rect.
    expect(window.dw.portalSetBounds).toHaveBeenCalledWith(
      's1',
      { x: 0, y: 0, width: 100, height: 80 },
      1, // transform[2] = zoom
      true,
    );
    expect(ResizeObserverStub.instances).toHaveLength(1);
    expect(occ.observeOcclusion).toHaveBeenCalledTimes(1);
  });

  it('shows the initial url in the address bar and a loading placeholder', () => {
    renderPortal();
    expect(screen.getByDisplayValue('https://dogwalker.dev')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter a URL…')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('updates url, title and nav state from a portal nav event', () => {
    renderPortal();
    act(() => {
      navListener!({
        id: 's1',
        url: 'https://example.com/page',
        title: 'Example',
        canGoBack: true,
        canGoForward: false,
      });
    });
    expect(screen.getByDisplayValue('https://example.com/page')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(screen.getByTitle('Back')).toBeEnabled();
    expect(screen.getByTitle('Forward')).toBeDisabled();
  });

  it('ignores nav events for other portals', () => {
    renderPortal();
    act(() => {
      navListener!({
        id: 'other',
        url: 'https://evil.example',
        title: 'Evil',
        canGoBack: true,
        canGoForward: true,
      });
    });
    expect(screen.getByDisplayValue('https://dogwalker.dev')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('clears the address bar for about:blank or empty urls', () => {
    renderPortal();
    act(() => {
      navListener!({ id: 's1', url: 'about:blank', title: 'New Tab', canGoBack: false, canGoForward: false });
    });
    expect(screen.getByDisplayValue('')).toBeInTheDocument();
    act(() => {
      navListener!({ id: 's1', url: '', title: '', canGoBack: false, canGoForward: false });
    });
    expect(screen.getByDisplayValue('')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('navigates with the trimmed url when Enter is pressed', () => {
    renderPortal();
    const input = screen.getByPlaceholderText('Enter a URL…');
    fireEvent.change(input, { target: { value: '  https://dogwalker.dev/docs  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.dw.portalNavigate).toHaveBeenCalledWith('s1', 'https://dogwalker.dev/docs');
  });

  it('does not navigate for a whitespace-only url', () => {
    renderPortal();
    const input = screen.getByPlaceholderText('Enter a URL…');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.dw.portalNavigate).not.toHaveBeenCalled();
  });

  it('ignores non-Enter keys in the address bar', () => {
    renderPortal();
    const input = screen.getByPlaceholderText('Enter a URL…');
    fireEvent.change(input, { target: { value: 'https://dogwalker.dev/docs' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(window.dw.portalNavigate).not.toHaveBeenCalled();
  });

  it('routes back, forward and reload buttons to main', () => {
    renderPortal();
    act(() => {
      navListener!({ id: 's1', url: 'https://example.com', title: 't', canGoBack: true, canGoForward: true });
    });
    fireEvent.click(screen.getByTitle('Back'));
    fireEvent.click(screen.getByTitle('Forward'));
    fireEvent.click(screen.getByTitle('Reload'));
    expect(window.dw.portalBack).toHaveBeenCalledWith('s1');
    expect(window.dw.portalForward).toHaveBeenCalledWith('s1');
    expect(window.dw.portalReload).toHaveBeenCalledWith('s1');
  });

  it('disables back and forward until history exists', () => {
    renderPortal();
    expect(screen.getByTitle('Back')).toBeDisabled();
    expect(screen.getByTitle('Forward')).toBeDisabled();
  });

  it('dispatches dw:portal-link when the link button is clicked', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderPortal();
    fireEvent.click(screen.getByTitle('New linked portal (shares this session)'));
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const evt = dispatchSpy.mock.calls[0][0] as CustomEvent;
    expect(evt.type).toBe('dw:portal-link');
    expect(evt.detail).toEqual({ stableId: 's1' });
    dispatchSpy.mockRestore();
  });

  it('unregisters and removes the node when closed', () => {
    renderPortal();
    fireEvent.click(screen.getByTitle('Close portal'));
    expect(window.dw.portalUnregister).toHaveBeenCalledWith('s1');
    expect(h.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: 'p1' }] });
  });

  it('destroys the portal and unsubscribes on unmount', () => {
    const { unmount } = renderPortal();
    unmount();
    expect(offNav).toHaveBeenCalled();
    expect(window.dw.portalDestroy).toHaveBeenCalledWith('s1');
  });

  it('marks the node as selected', () => {
    const { container } = renderPortal({ selected: true });
    expect(container.querySelector('.dw-portal')?.className).toContain('dw-node-selected');
  });

  it('re-clips bounds when occluders change', () => {
    renderPortal();
    const holes: Rect[] = [{ x: 10, y: 10, width: 40, height: 40 }];
    act(() => {
      occlusionListener!(holes);
    });
    expect(occ.clipToOccluders).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 0, height: 0 }, holes);
    expect(window.dw.portalSetBounds).toHaveBeenCalledTimes(2);
  });

  it('hides the portal when the clip collapses', () => {
    occ.clipToOccluders.mockReturnValue({ x: 0, y: 0, width: 1, height: 1 });
    renderPortal();
    expect(window.dw.portalSetBounds).toHaveBeenLastCalledWith(
      's1',
      { x: 0, y: 0, width: 1, height: 1 },
      1,
      false,
    );
    // Height-only collapse exercises the second operand of the visibility check.
    occ.clipToOccluders.mockReturnValue({ x: 0, y: 0, width: 100, height: 1 });
    occlusionListener!([]);
    expect(window.dw.portalSetBounds).toHaveBeenLastCalledWith(
      's1',
      { x: 0, y: 0, width: 100, height: 1 },
      1,
      false,
    );
  });

  it('re-aligns bounds when the canvas transform changes', () => {
    const props = {
      id: 'p1',
      data: { name: 'Web', stableId: 's1', url: 'https://dogwalker.dev', partition: 'persist:dw' },
      selected: false,
    } as unknown as NodeProps<PortalFlowNode>;
    const { rerender } = render(<PortalNode {...props} />);
    expect(window.dw.portalSetBounds).toHaveBeenLastCalledWith('s1', expect.anything(), 1, true);
    h.transform = [0, 0, 2];
    // memo() bails out on identical props, so flip `selected` to force a
    // re-render; the transform identity change then re-triggers the sync effect.
    rerender(<PortalNode {...props} selected={true} />);
    expect(window.dw.portalSetBounds).toHaveBeenLastCalledWith('s1', expect.anything(), 2, true);
  });

  it('re-syncs bounds when the ResizeObserver fires', () => {
    renderPortal();
    const ro = ResizeObserverStub.instances[0];
    expect(window.dw.portalSetBounds).toHaveBeenCalledTimes(1);
    ro.callback();
    expect(window.dw.portalSetBounds).toHaveBeenCalledTimes(2);
  });
});
