import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { CodeEditor } from './CodeEditor';

// jsdom lacks a few DOM APIs CodeMirror relies on; provide inert stand-ins.
function patchJsdomGaps() {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {};
  }
  // jsdom's Range has no geometry methods; CodeMirror measures text with them.
  const noRects = (): DOMRectList => [] as unknown as DOMRectList;
  const noRect = (): DOMRect =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = noRects;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = noRect;
  }
}

function renderEditor(filePath: string, gotoLine?: number) {
  const props = {
    filePath,
    onClose: vi.fn(),
    onSend: vi.fn(),
    ...(gotoLine !== undefined ? { gotoLine } : {}),
  };
  const utils = render(
    <CodeEditor
      filePath={props.filePath}
      onClose={props.onClose}
      onSend={props.onSend}
      {...(gotoLine !== undefined ? { gotoLine } : {})}
    />,
  );
  return { ...utils, onClose: props.onClose, onSend: props.onSend };
}

function getView(container: HTMLElement): EditorView {
  const host = container.querySelector<HTMLElement>('.dw-editor-host')!;
  const view = EditorView.findFromDOM(host);
  if (!view) throw new Error('CodeMirror view not created');
  return view;
}

/** Dispatch a change as if the user typed, then flush React. */
async function typeText(container: HTMLElement, insert: string) {
  const view = getView(container);
  await act(async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert } });
  });
}

/** Select from line a to line b (1-based, inclusive) and flush React. */
async function selectLines(container: HTMLElement, a: number, b: number) {
  const view = getView(container);
  const doc = view.state.doc;
  await act(async () => {
    view.dispatch({ selection: { anchor: doc.line(a).from, head: doc.line(b).to } });
  });
}

const CONTENT = 'line one\nline two\nline three';

beforeEach(() => {
  patchJsdomGaps();
  window.dw = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
  } as unknown as typeof window.dw;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CodeEditor', () => {
  it('loads the file and renders its content in the editor', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container } = renderEditor('/repo/src/App.tsx');
    expect(window.dw.readFile).toHaveBeenCalledWith('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });
    // CodeMirror puts each line in its own .cm-line; compare line by line.
    const lines = Array.from(container.querySelectorAll('.cm-line')).map((l) => l.textContent);
    expect(lines).toEqual(['line one', 'line two', 'line three']);
    expect(screen.getByText('App.tsx')).toBeInTheDocument();
  });

  it('closes via the back button', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { onClose } = renderEditor('/repo/src/App.tsx');
    fireEvent.click(screen.getByTitle('Back to list'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves through window.dw.writeFile and shows a transient "saved" badge', async () => {
    vi.useFakeTimers();
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    vi.mocked(window.dw.writeFile).mockResolvedValue(undefined);
    const { container } = renderEditor('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { await Promise.resolve(); });
    expect(window.dw.writeFile).toHaveBeenCalledWith('/repo/src/App.tsx', CONTENT);
    expect(screen.getByText('saved')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
    expect(screen.queryByText('saved')).not.toBeInTheDocument();
    expect(container.querySelector('.dw-editor-dot')).not.toBeInTheDocument();
  });

  it('does nothing when Save is pressed before the file loads', async () => {
    vi.mocked(window.dw.readFile).mockImplementation(
      () => new Promise<string>(() => {}),
    );
    renderEditor('/repo/src/App.tsx');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(window.dw.writeFile).not.toHaveBeenCalled();
  });

  it('marks the editor dirty when the document changes', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container } = renderEditor('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.dw-editor-dot')).not.toBeInTheDocument();

    await typeText(container, '\nfourth line');
    expect(container.querySelector('.dw-editor-dot')).toBeInTheDocument();
  });

  it('enables Send only when there is a selection and sends text with a ref', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container, onSend } = renderEditor('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });
    const sendBtn = screen.getByRole('button', { name: /Send →/ });
    expect(sendBtn).toBeDisabled();

    await selectLines(container, 1, 2);
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    expect(onSend).toHaveBeenCalledWith('line one\nline two', 'App.tsx:1-2');
  });

  it('uses a single line reference for a one-line selection', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container, onSend } = renderEditor('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });
    const view = getView(container);
    await act(async () => {
      view.dispatch({ selection: { anchor: 0, head: 8 } }); // 'line one'
    });
    fireEvent.click(screen.getByRole('button', { name: /Send →/ }));
    expect(onSend).toHaveBeenCalledWith('line one', 'App.tsx:1');
  });

  it('jumps to and selects the requested line on open', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container } = renderEditor('/repo/src/App.tsx', 2);
    await act(async () => { await Promise.resolve(); });
    const view = getView(container);
    const sel = view.state.selection.main;
    const line2 = view.state.doc.line(2);
    expect(sel.from).toBe(line2.from);
    expect(sel.to).toBe(line2.to);
    expect(view.hasFocus).toBe(true);
  });

  it('ignores an out-of-range gotoLine', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container } = renderEditor('/repo/src/App.tsx', 99);
    await act(async () => { await Promise.resolve(); });
    const view = getView(container);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it('saves via the Mod-s keybinding', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    vi.mocked(window.dw.writeFile).mockResolvedValue(undefined);
    const { container } = renderEditor('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });
    const content = container.querySelector('.cm-content')!;
    fireEvent.keyDown(content, { key: 's', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(window.dw.writeFile).toHaveBeenCalledWith('/repo/src/App.tsx', CONTENT);
  });

  it('never shows a dirty marker when a foreign file type loads cleanly', async () => {
    // Exercises the "unknown extension" path of langFor (plain editor).
    vi.mocked(window.dw.readFile).mockResolvedValue('plain text');
    const { container } = renderEditor('/repo/data.bin');
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.cm-content')).toHaveTextContent('plain text');
    expect(container.querySelector('.dw-editor-dot')).not.toBeInTheDocument();
  });

  it('loads a Rust file through the rust language extension', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue('fn main() {}');
    const { container } = renderEditor('/repo/src/main.rs');
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.cm-content')).toHaveTextContent('fn main() {}');
  });

  it('ignores the file content if unmounted while the read is in flight', async () => {
    vi.mocked(window.dw.readFile).mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(CONTENT), 10)),
    );
    const { unmount } = renderEditor('/repo/src/App.tsx');
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(window.dw.readFile).toHaveBeenCalledTimes(1);
  });

  it('destroys the editor view on unmount', async () => {
    vi.mocked(window.dw.readFile).mockResolvedValue(CONTENT);
    const { container, unmount } = renderEditor('/repo/src/App.tsx');
    await act(async () => { await Promise.resolve(); });
    const host = container.querySelector<HTMLElement>('.dw-editor-host')!;
    expect(EditorView.findFromDOM(host)).not.toBeNull();
    unmount();
    expect(EditorView.findFromDOM(host)).toBeNull();
  });
});
