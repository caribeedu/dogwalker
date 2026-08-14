import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import type { NoteFlowNode } from './NoteNode';
import { NoteNode } from './NoteNode';

const h = vi.hoisted(() => ({ deleteElements: vi.fn() }));

// Stub React Flow's DOM-measuring components (NodeResizer, Handles) and keep
// the delete path on a spy. Position is a runtime enum used as a prop value.
vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  useReactFlow: () => ({ deleteElements: h.deleteElements }),
}));

function renderNote(overrides: Partial<Record<string, unknown>> = {}) {
  const props = {
    id: 'n1',
    data: { name: 'Shopping', stableId: 's1' },
    selected: false,
    ...overrides,
  } as unknown as NodeProps<NoteFlowNode>;
  return render(<NoteNode {...props} />);
}

/** Build a fake paste event carrying clipboard items (jsdom's ClipboardEvent
 *  ignores clipboardData, so hand-construct the native event). */
function pasteEvent(items: Array<{ type: string; getAsFile: () => unknown }>) {
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { items },
  });
  return paste;
}

function fakeImageFile(name: string): File {
  return {
    name,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]),
  } as unknown as File;
}

describe('NoteNode', () => {
  beforeEach(() => {
    h.deleteElements.mockClear();
    window.dw = {
      readNote: vi.fn().mockResolvedValue(''),
      saveNote: vi.fn(),
      saveNoteImage: vi.fn().mockResolvedValue('/notes/s1/paste.png'),
      renameNote: vi.fn(),
      deleteNote: vi.fn(),
      onNoteUpdate: vi.fn().mockReturnValue(() => {}),
      readImage: vi.fn().mockResolvedValue(''),
    } as unknown as typeof window.dw;
  });

  it('renders the markdown content loaded from readNote', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('# Hi there');
    renderNote();
    expect(await screen.findByRole('heading', { name: 'Hi there' })).toBeInTheDocument();
    expect(window.dw.readNote).toHaveBeenCalledWith('s1');
  });

  it('shows the empty hint when the note has no content', async () => {
    renderNote();
    expect(
      await screen.findByText('Empty note — double-click to edit.'),
    ).toBeInTheDocument();
  });

  it('shows the empty hint for whitespace-only content', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('   \n  ');
    renderNote();
    expect(
      await screen.findByText('Empty note — double-click to edit.'),
    ).toBeInTheDocument();
  });

  it('renders GFM markdown (strikethrough, bold)', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('~~gone~~ **bold**');
    renderNote();
    expect(await screen.findByText('gone')).toBeInTheDocument();
    expect(screen.getByText('gone').tagName).toBe('DEL');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('switches between formatted and raw edit mode', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('# Hi');
    renderNote();
    await screen.findByRole('heading', { name: 'Hi' });
    fireEvent.click(screen.getByTitle('Show raw markdown'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show formatted'));
    expect(await screen.findByRole('heading', { name: 'Hi' })).toBeInTheDocument();
  });

  it('double-clicking the formatted body enters edit mode', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('some text');
    const { container } = renderNote();
    await screen.findByText('some text');
    const body = container.querySelector('.dw-note-md');
    expect(body).not.toBeNull();
    fireEvent.dblClick(body!);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('some text');
  });

  it('debounces the save to window.dw.saveNote after 400ms', () => {
    vi.useFakeTimers();
    try {
      renderNote();
      fireEvent.click(screen.getByTitle('Show raw markdown'));
      const ta = screen.getByRole('textbox');
      fireEvent.change(ta, { target: { value: 'hello' } });
      expect(window.dw.saveNote).not.toHaveBeenCalled();
      vi.advanceTimersByTime(399);
      expect(window.dw.saveNote).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(window.dw.saveNote).toHaveBeenCalledTimes(1);
      expect(window.dw.saveNote).toHaveBeenCalledWith('s1', 'hello');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the debounce on rapid edits (single save with last content)', () => {
    vi.useFakeTimers();
    try {
      renderNote();
      fireEvent.click(screen.getByTitle('Show raw markdown'));
      const ta = screen.getByRole('textbox');
      fireEvent.change(ta, { target: { value: 'a' } });
      vi.advanceTimersByTime(200);
      fireEvent.change(ta, { target: { value: 'ab' } });
      vi.advanceTimersByTime(399);
      expect(window.dw.saveNote).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(window.dw.saveNote).toHaveBeenCalledTimes(1);
      expect(window.dw.saveNote).toHaveBeenCalledWith('s1', 'ab');
    } finally {
      vi.useRealTimers();
    }
  });

  it('embeds a remote https image URL without calling readImage', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('![doc](https://x.example/y.png)');
    renderNote();
    const img = await screen.findByAltText('doc');
    expect(img).toHaveAttribute('src', 'https://x.example/y.png');
    expect(window.dw.readImage).not.toHaveBeenCalled();
  });

  it('shows the placeholder for a data: URI image (sanitized by react-markdown v10)', async () => {
    // react-markdown's defaultUrlTransform strips non-safe protocols (`data:`
    // is not in its safeProtocol set) to '', so the src never reaches NoteImage.
    vi.mocked(window.dw.readNote).mockResolvedValue('![doc](data:image/png;base64,AA)');
    renderNote();
    expect(await screen.findByText('doc')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(window.dw.readImage).not.toHaveBeenCalled();
  });

  it('reads a local image path through main and renders the data URI', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('![pic](/abs/pic.png)');
    vi.mocked(window.dw.readImage).mockResolvedValue('data:image/png;base64,AA');
    renderNote();
    const img = await screen.findByAltText('pic');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AA');
    expect(window.dw.readImage).toHaveBeenCalledWith('/abs/pic.png');
  });

  it('shows the placeholder when a local image cannot be read', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('![pic](/abs/pic.png)');
    renderNote();
    expect(await screen.findByText('pic')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the generic placeholder for an img without a src', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('![]()');
    renderNote();
    expect(await screen.findByText('image')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('ignores a pending image read result after unmount', async () => {
    let resolveImg!: (v: string) => void;
    vi.mocked(window.dw.readNote).mockResolvedValue('![pic](/abs/pic.png)');
    vi.mocked(window.dw.readImage).mockImplementation(
      () => new Promise((r) => { resolveImg = r; }),
    );
    const { unmount } = renderNote();
    await screen.findByText('pic');
    unmount();
    resolveImg('data:image/png;base64,AA');
    await waitFor(() => expect(window.dw.readImage).toHaveBeenCalled());
  });

  it('stores a pasted image via saveNoteImage with the file name', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('abc');
    // The embed insertion after this call crashes in production: NoteNode.tsx:69
    // reads `e.currentTarget` after the awaits, and React nulls currentTarget once
    // dispatch completes — so the handler never reaches the `![image](...)` insert.
    // Characterization: pin everything up to that latent bug (deferred v0.3 feature).
    vi.mocked(window.dw.saveNoteImage).mockReturnValue(new Promise(() => {}));
    renderNote();
    await screen.findByText('abc');
    fireEvent.click(screen.getByTitle('Show raw markdown'));
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent(ta, pasteEvent([{ type: 'image/png', getAsFile: () => fakeImageFile('shot.png') }]));
    await waitFor(() =>
      expect(window.dw.saveNoteImage).toHaveBeenCalledWith(
        's1',
        'shot.png',
        new Uint8Array([1, 2, 3]),
      ),
    );
  });

  it('falls back to paste.png for a pasted image with no name', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('abc');
    vi.mocked(window.dw.saveNoteImage).mockReturnValue(new Promise(() => {}));
    renderNote();
    await screen.findByText('abc');
    fireEvent.click(screen.getByTitle('Show raw markdown'));
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent(ta, pasteEvent([{ type: 'image/png', getAsFile: () => fakeImageFile('') }]));
    await waitFor(() =>
      expect(window.dw.saveNoteImage).toHaveBeenCalledWith(
        's1',
        'paste.png',
        new Uint8Array([1, 2, 3]),
      ),
    );
  });

  it('ignores non-image pastes', async () => {
    vi.mocked(window.dw.readNote).mockResolvedValue('abc');
    renderNote();
    await screen.findByText('abc');
    fireEvent.click(screen.getByTitle('Show raw markdown'));
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent(ta, pasteEvent([{ type: 'text/plain', getAsFile: () => null }]));
    expect(window.dw.saveNoteImage).not.toHaveBeenCalled();
    expect(ta.value).toBe('abc');
  });

  it('renames the note on Enter', async () => {
    renderNote();
    await screen.findByText('Shopping');
    fireEvent.doubleClick(screen.getByText('Shopping'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Groceries' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.dw.renameNote).toHaveBeenCalledWith('s1', 'Groceries');
    expect(await screen.findByText('Groceries')).toBeInTheDocument();
  });

  it('renames the note on blur', async () => {
    renderNote();
    await screen.findByText('Shopping');
    fireEvent.doubleClick(screen.getByText('Shopping'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Groceries' } });
    fireEvent.blur(input);
    expect(window.dw.renameNote).toHaveBeenCalledWith('s1', 'Groceries');
    expect(await screen.findByText('Groceries')).toBeInTheDocument();
  });

  it('falls back to the original name when the new name is blank', async () => {
    renderNote();
    await screen.findByText('Shopping');
    fireEvent.doubleClick(screen.getByText('Shopping'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.dw.renameNote).toHaveBeenCalledWith('s1', 'Shopping');
    expect(await screen.findByText('Shopping')).toBeInTheDocument();
  });

  it('deletes the note file and removes the node on close', async () => {
    renderNote();
    await screen.findByText('Shopping');
    fireEvent.click(screen.getByTitle('Delete note'));
    expect(window.dw.deleteNote).toHaveBeenCalledWith('s1');
    expect(h.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: 'n1' }] });
  });

  it('marks the node as selected', async () => {
    const { container } = renderNote({ selected: true });
    await screen.findByText('Shopping');
    expect(container.querySelector('.dw-note')?.className).toContain('dw-node-selected');
  });

  it('refreshes content when the note updates out-of-band', async () => {
    let notify: ((id: string) => void) | undefined;
    vi.mocked(window.dw.onNoteUpdate).mockImplementation((cb) => {
      notify = cb;
      return () => {};
    });
    vi.mocked(window.dw.readNote)
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2');
    renderNote();
    expect(await screen.findByText('v1')).toBeInTheDocument();
    notify?.('s1');
    expect(await screen.findByText('v2')).toBeInTheDocument();
    expect(window.dw.readNote).toHaveBeenCalledTimes(2);
  });

  it('ignores note updates for other notes', async () => {
    let notify: ((id: string) => void) | undefined;
    vi.mocked(window.dw.onNoteUpdate).mockImplementation((cb) => {
      notify = cb;
      return () => {};
    });
    vi.mocked(window.dw.readNote).mockResolvedValueOnce('v1');
    renderNote();
    expect(await screen.findByText('v1')).toBeInTheDocument();
    notify?.('other-note');
    expect(window.dw.readNote).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from note updates on unmount', () => {
    const unsubscribe = vi.fn();
    vi.mocked(window.dw.onNoteUpdate).mockReturnValue(unsubscribe);
    const { unmount } = renderNote();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
