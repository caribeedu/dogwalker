import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import type { DirListing, FileEntry, GitStatus } from '../shared/ipc';
import { FileTreeNode, type FileTreeFlowNode } from './FileTreeNode';

const h = vi.hoisted(() => ({ deleteElements: vi.fn() }));

// Stub React Flow's resizer (needs real DOM measurement) and keep the delete
// path on a spy — the same pattern as PreviewNode.test.tsx.
vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  useReactFlow: () => ({ deleteElements: h.deleteElements }),
}));

// The subcomponents do their own IPC round-trips (CodeEditor even builds a
// CodeMirror instance, which needs real layout); stub them so the tree node's
// own behavior is what's under test. Each stub surfaces its props and exposes
// the callbacks the node passes down.
vi.mock('./CodeEditor', () => ({
  CodeEditor: (props: {
    filePath: string;
    gotoLine?: number;
    onClose: () => void;
    onSend: (text: string, ref: string) => void;
  }) => (
    <div>
      <span>EDITOR:{props.filePath}:{props.gotoLine ?? 'none'}</span>
      <button onClick={props.onClose}>editor-close</button>
      <button onClick={() => props.onSend('hello world', 'notes.md:3')}>editor-send</button>
    </div>
  ),
}));

vi.mock('./GitDiffView', () => ({
  GitDiffView: (props: { cwd: string; reloadKey: number }) => (
    <div>DIFFVIEW:{props.cwd}:{props.reloadKey}</div>
  ),
}));

vi.mock('./GitGraphView', () => ({
  GitGraphView: (props: { cwd: string }) => <div>GRAPHVIEW:{props.cwd}</div>,
}));

vi.mock('./GitBranchMenu', () => ({
  GitBranchMenu: (props: {
    cwd: string;
    status: GitStatus;
    onClose: () => void;
    onChanged: () => void;
  }) => (
    <div>
      <span>BRANCHMENU:{props.cwd}:{props.status.branch}</span>
      <button onClick={props.onChanged}>branch-changed</button>
      <button onClick={props.onClose}>branch-close</button>
    </div>
  ),
}));

const ROOT = '/root';

function entry(name: string, path: string, isDir: boolean, size = 0): FileEntry {
  return { name, path, isDir, size, mtime: 0 };
}

function listing(dir: string, entries: FileEntry[], error?: string): DirListing {
  return { path: dir, entries, error };
}

function renderTree(overrides: Partial<Record<string, unknown>> = {}) {
  const props = {
    id: 'ft1',
    data: { name: 'Files', stableId: 's1', rootPath: ROOT, workspaceId: 'ws1' },
    selected: false,
    ...overrides,
  } as unknown as NodeProps<FileTreeFlowNode>;
  return render(<FileTreeNode {...props} />);
}

function noRepo(): GitStatus {
  return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] };
}

describe('FileTreeNode', () => {
  beforeEach(() => {
    h.deleteElements.mockClear();
    window.dw = {
      readDir: vi.fn(async (dir: string) => listing(dir, [])),
      gitStatus: vi.fn(async () => noRepo()),
      searchFiles: vi.fn(async () => []),
      grepFiles: vi.fn(async () => []),
      createEntry: vi.fn(async () => ''),
      renameEntry: vi.fn(async () => {}),
      removeEntry: vi.fn(async () => {}),
      pickDirectory: vi.fn(async () => ''),
      listTerminals: vi.fn(async () => []),
      write: vi.fn(),
    } as unknown as typeof window.dw;
  });

  it('renders the root and its children after the initial load', async () => {
    const children = [
      entry('src', `${ROOT}/src`, true),
      entry('notes.md', `${ROOT}/notes.md`, false, 12000),
      entry('logo.png', `${ROOT}/logo.png`, false, 2 * 1024 * 1024),
      entry('data.json', `${ROOT}/data.json`, false, 500),
      entry('bundle.zip', `${ROOT}/bundle.zip`, false, 0),
    ];
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? children : []),
    );

    const { container } = renderTree();

    expect(await screen.findByText('root')).toBeInTheDocument();
    expect(window.dw.readDir).toHaveBeenCalledWith(ROOT);
    expect(window.dw.gitStatus).toHaveBeenCalledWith(ROOT);
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('notes.md')).toBeInTheDocument();
    // humanSize branches: bytes, KB, MB
    expect(screen.getByText('12 K')).toBeInTheDocument();
    expect(screen.getByText('2.0 M')).toBeInTheDocument();
    expect(screen.getByText('500 B')).toBeInTheDocument();
    // iconFor branches: dir, image, code, doc, archive
    expect(container.querySelectorAll('.dw-ft-row')).toHaveLength(5);
    expect(container.querySelectorAll('.dw-ft-icon')).toHaveLength(5);
  });

  it('expands a directory on click and collapses it again', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(
        dir,
        dir === ROOT
          ? [entry('src', `${ROOT}/src`, true)]
          : [entry('main.ts', `${ROOT}/src/main.ts`, false, 5)],
      ),
    );
    renderTree();
    const srcRow = await screen.findByText('src');
    fireEvent.click(srcRow);
    expect(await screen.findByText('main.ts')).toBeInTheDocument();
    expect(window.dw.readDir).toHaveBeenCalledWith(`${ROOT}/src`);
    fireEvent.click(srcRow);
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();
  });

  it('shows the readDir error inside the tree', async () => {
    vi.mocked(window.dw.readDir).mockResolvedValue(listing(ROOT, [], 'EACCES: permission denied'));
    const { container } = renderTree();
    expect(await screen.findByText('EACCES: permission denied')).toBeInTheDocument();
    expect(container.querySelector('.dw-ft-error')).toBeInTheDocument();
  });

  it('shows a placeholder for an empty root', async () => {
    renderTree();
    expect(await screen.findByText('Empty folder')).toBeInTheDocument();
  });

  it('commits a changed root from the inline editor', async () => {
    renderTree();
    const rootSpan = await screen.findByTitle(/double-click to change root/);
    fireEvent.doubleClick(rootSpan);
    const input = screen.getByDisplayValue(ROOT) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  /work/x  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('x')).toBeInTheDocument();
    expect(window.dw.readDir).toHaveBeenCalledWith('/work/x');
    expect(window.dw.gitStatus).toHaveBeenCalledWith('/work/x');
  });

  it('does not reload when the committed root is unchanged', async () => {
    renderTree();
    const rootSpan = await screen.findByTitle(/double-click to change root/);
    fireEvent.doubleClick(rootSpan);
    const input = screen.getByDisplayValue(ROOT);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByDisplayValue(ROOT)).not.toBeInTheDocument();
    expect(window.dw.readDir).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty root commit and Escape cancels editing', async () => {
    renderTree();
    const rootSpan = await screen.findByTitle(/double-click to change root/);
    fireEvent.doubleClick(rootSpan);
    const input = screen.getByDisplayValue(ROOT);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByDisplayValue(ROOT)).not.toBeInTheDocument();
    expect(window.dw.readDir).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(screen.getByTitle(/double-click to change root/));
    const input2 = screen.getByDisplayValue(ROOT);
    fireEvent.change(input2, { target: { value: '/other' } });
    fireEvent.keyDown(input2, { key: 'Escape' });
    expect(screen.getByTitle(/double-click to change root/)).toHaveTextContent('root');
    expect(window.dw.readDir).not.toHaveBeenCalledWith('/other');
  });

  it('picks a new root folder with the picker', async () => {
    vi.mocked(window.dw.pickDirectory).mockResolvedValue('/picked');
    renderTree();
    fireEvent.click(await screen.findByTitle('Choose root folder'));
    expect(await screen.findByText('picked')).toBeInTheDocument();
    expect(window.dw.readDir).toHaveBeenCalledWith('/picked');
  });

  it('ignores a cancelled folder picker', async () => {
    vi.mocked(window.dw.pickDirectory).mockResolvedValue('');
    renderTree();
    fireEvent.click(await screen.findByTitle('Choose root folder'));
    await act(async () => {});
    expect(window.dw.readDir).toHaveBeenCalledTimes(1);
  });

  it('refreshes the listing and git status', async () => {
    renderTree();
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByTitle('Refresh'));
    await act(async () => {});
    expect(window.dw.readDir).toHaveBeenCalledTimes(2);
    // refreshGit() + the gitReload-triggered effect re-run
    expect(window.dw.gitStatus).toHaveBeenCalledTimes(3);
  });

  it('removes itself through React Flow deleteElements', async () => {
    renderTree();
    fireEvent.click(await screen.findByTitle('Remove file tree'));
    expect(h.deleteElements).toHaveBeenCalledWith({ nodes: [{ id: 'ft1' }] });
  });

  it('opens a context menu on a row with position and prevents default', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 25,
    });
    const preventSpy = vi.spyOn(ev, 'preventDefault');
    fireEvent(row, ev);
    expect(preventSpy).toHaveBeenCalled();
    expect(screen.getByText('New file')).toBeInTheDocument();
    expect(screen.getByText('New folder')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
    const menu = document.querySelector('.dw-ctxmenu') as HTMLElement;
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('25px');
    // A click anywhere closes the menu (window listener in FileMenu).
    fireEvent.click(document.body);
    expect(document.querySelector('.dw-ctxmenu')).not.toBeInTheDocument();
  });

  it('shows only create actions on the background menu', async () => {
    renderTree();
    await screen.findByText('Empty folder');
    const host = document.querySelector('.dw-ft')!;
    fireEvent.contextMenu(host);
    expect(screen.getByText('New file')).toBeInTheDocument();
    expect(screen.getByText('New folder')).toBeInTheDocument();
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('creates a file next to a selected file', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('New file'));
    expect(screen.getByText('New file name')).toBeInTheDocument();
    const input = document.querySelector('.dw-ft-prompt-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'x.txt' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(window.dw.createEntry).toHaveBeenCalledWith(`${ROOT}/x.txt`, false);
    expect(window.dw.readDir).toHaveBeenCalledTimes(2); // mount + reload of the root
  });

  it('creates a folder inside a selected directory', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(
        dir,
        dir === ROOT
          ? [entry('src', `${ROOT}/src`, true)]
          : dir === `${ROOT}/src`
            ? [entry('lib', `${ROOT}/src/lib`, true)]
            : [],
      ),
    );
    renderTree();
    const row = (await screen.findByText('src')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('New folder'));
    expect(screen.getByText('New folder name')).toBeInTheDocument();
    const input = document.querySelector('.dw-ft-prompt-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'lib' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.dw.createEntry).toHaveBeenCalledWith(`${ROOT}/src/lib`, true);
    // The new folder is added to `expanded`, so its listing loads and shows.
    expect(await screen.findByText('lib')).toBeInTheDocument();
  });

  it('creates an entry at the root from the background menu via OK', async () => {
    renderTree();
    await screen.findByText('Empty folder');
    const host = document.querySelector('.dw-ft')!;
    fireEvent.contextMenu(host);
    fireEvent.click(screen.getByText('New file'));
    const input = document.querySelector('.dw-ft-prompt-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'root.txt' } });
    fireEvent.click(screen.getByText('OK'));
    await act(async () => {});
    expect(window.dw.createEntry).toHaveBeenCalledWith(`${ROOT}/root.txt`, false);
  });

  it('closes the create prompt without creating', async () => {
    renderTree();
    await screen.findByText('Empty folder');
    const host = document.querySelector('.dw-ft')!;
    fireEvent.contextMenu(host);
    fireEvent.click(screen.getByText('New file'));
    // Enter with an empty name is a no-op but closes the prompt.
    const input = document.querySelector('.dw-ft-prompt-input') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.dw.createEntry).not.toHaveBeenCalled();
    expect(screen.queryByText('New file name')).not.toBeInTheDocument();
    // Reopen and cancel with the button.
    fireEvent.contextMenu(host);
    fireEvent.click(screen.getByText('New file'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New file name')).not.toBeInTheDocument();
    expect(window.dw.createEntry).not.toHaveBeenCalled();
  });

  it('renames an entry through the context menu', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.getByText('Rename notes.md')).toBeInTheDocument();
    const input = screen.getByDisplayValue('notes.md') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'renamed.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(window.dw.renameEntry).toHaveBeenCalledWith(`${ROOT}/notes.md`, `${ROOT}/renamed.md`);
    expect(window.dw.readDir).toHaveBeenCalledTimes(2); // mount + reload of the parent
  });

  it('does not rename when the name is unchanged', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('notes.md') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'notes.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(window.dw.renameEntry).not.toHaveBeenCalled();
  });

  it('cancels the rename prompt with Escape', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Rename'));
    const input = screen.getByDisplayValue('notes.md') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('Rename notes.md')).not.toBeInTheDocument();
    expect(window.dw.renameEntry).not.toHaveBeenCalled();
  });

  it('deletes an entry after confirmation', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete “notes.md”?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await act(async () => {});
    expect(window.dw.removeEntry).toHaveBeenCalledWith(`${ROOT}/notes.md`);
    expect(window.dw.readDir).toHaveBeenCalledTimes(2); // reload of the parent
    expect(screen.queryByText('Delete “notes.md”?')).not.toBeInTheDocument();
  });

  it('cancels the delete confirmation', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.dw.removeEntry).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete “notes.md”?')).not.toBeInTheDocument();
  });

  it('shows git chrome and diff/graph views for a repo', async () => {
    const status: GitStatus = {
      isRepo: true,
      branch: 'main',
      ahead: 1,
      behind: 2,
      files: [{ path: 'a.ts', index: 'M', work: 'M' }],
    };
    vi.mocked(window.dw.gitStatus).mockResolvedValue(status);
    renderTree();
    expect(await screen.findByText('main')).toBeInTheDocument();
    expect(screen.getByText('Diff')).toBeInTheDocument();
    expect(screen.getByText('Graph')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // changed-files badge
    fireEvent.click(screen.getByText('Diff'));
    expect(await screen.findByText(`DIFFVIEW:${ROOT}:0`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Graph'));
    expect(await screen.findByText(`GRAPHVIEW:${ROOT}`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('List'));
    expect(await screen.findByText('Empty folder')).toBeInTheDocument();
  });

  it('opens the branch menu and refreshes on change', async () => {
    vi.mocked(window.dw.gitStatus).mockResolvedValue({
      isRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: [],
    });
    renderTree();
    fireEvent.click(await screen.findByTitle('Branch & git operations'));
    expect(await screen.findByText(`BRANCHMENU:${ROOT}:main`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('branch-changed'));
    await act(async () => {});
    // refreshGit() in onChanged + the gitReload-triggered effect re-run
    expect(window.dw.gitStatus).toHaveBeenCalledTimes(3);
    expect(window.dw.readDir).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByText('branch-close'));
    expect(screen.queryByText(/BRANCHMENU:/)).not.toBeInTheDocument();
  });

  it('hides git chrome outside a repo', async () => {
    renderTree();
    await screen.findByText('Empty folder');
    expect(screen.queryByText('Diff')).not.toBeInTheDocument();
    expect(screen.queryByText('Graph')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Branch & git operations')).not.toBeInTheDocument();
  });

  it('sends the selection straight to the only terminal', async () => {
    vi.mocked(window.dw.listTerminals).mockResolvedValue([
      { id: 't1', stableId: 's1', name: 'agent-a', preset: 'p1' },
    ]);
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.doubleClick(row);
    expect(await screen.findByText(`EDITOR:${ROOT}/notes.md:none`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('editor-send'));
    await act(async () => {});
    expect(window.dw.listTerminals).toHaveBeenCalledWith('ws1');
    expect(window.dw.write).toHaveBeenCalledWith('t1', 'notes.md:3\nhello world\n');
  });

  it('closes the editor back to the list', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.doubleClick(row);
    await screen.findByText(`EDITOR:${ROOT}/notes.md:none`);
    fireEvent.click(screen.getByText('editor-close'));
    expect(screen.queryByText(/EDITOR:/)).not.toBeInTheDocument();
    expect(await screen.findByText('notes.md')).toBeInTheDocument();
  });

  it('does nothing on send without a workspace id', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree({ data: { name: 'Files', stableId: 's1', rootPath: ROOT } });
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.doubleClick(row);
    fireEvent.click(await screen.findByText('editor-send'));
    await act(async () => {});
    expect(window.dw.listTerminals).not.toHaveBeenCalled();
    expect(window.dw.write).not.toHaveBeenCalled();
  });

  it('shows a picker when several terminals can receive the send', async () => {
    vi.mocked(window.dw.listTerminals).mockResolvedValue([
      { id: 't1', stableId: 's1', name: 'agent-a', preset: 'p1' },
      { id: 't2', stableId: 's2', name: 'agent-b', preset: 'p2' },
    ]);
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.doubleClick(row);
    fireEvent.click(await screen.findByText('editor-send'));
    expect(await screen.findByText(/Send “notes.md:3” to…/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('agent-b'));
    await act(async () => {});
    expect(window.dw.write).toHaveBeenCalledWith('t2', 'notes.md:3\nhello world\n');
    expect(screen.queryByText(/Send “notes.md:3”/)).not.toBeInTheDocument();
  });

  it('cancels the terminal picker without sending', async () => {
    vi.mocked(window.dw.listTerminals).mockResolvedValue([
      { id: 't1', stableId: 's1', name: 'agent-a', preset: 'p1' },
      { id: 't2', stableId: 's2', name: 'agent-b', preset: 'p2' },
    ]);
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    fireEvent.doubleClick(row);
    fireEvent.click(await screen.findByText('editor-send'));
    await screen.findByText(/Send “notes.md:3” to…/);
    fireEvent.click(screen.getByText('Cancel'));
    expect(window.dw.write).not.toHaveBeenCalled();
    expect(screen.queryByText(/Send “notes.md:3”/)).not.toBeInTheDocument();
  });

  it('filters the file index by name with fuzzy matching', async () => {
    vi.mocked(window.dw.searchFiles).mockResolvedValue([
      `${ROOT}/src/app.ts`,
      `${ROOT}/src/main.ts`,
      `${ROOT}/README.md`,
    ]);
    renderTree();
    fireEvent.click(await screen.findByTitle(/Search files/));
    expect(await screen.findByText('Indexed 3 files.')).toBeInTheDocument();
    expect(window.dw.searchFiles).toHaveBeenCalledWith(ROOT, 20000);
    const input = screen.getByPlaceholderText(/Filter files/);
    fireEvent.change(input, { target: { value: 'app' } });
    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(await screen.findByText('No matches.')).toBeInTheDocument();
    // Clicking a hit opens the editor (title is the unique full path).
    fireEvent.change(input, { target: { value: 'readme' } });
    fireEvent.click(await screen.findByTitle(`${ROOT}/README.md`));
    expect(await screen.findByText(`EDITOR:${ROOT}/README.md:none`)).toBeInTheDocument();
  });

  it('closes search with Escape', async () => {
    vi.mocked(window.dw.searchFiles).mockResolvedValue([`${ROOT}/a.ts`]);
    renderTree();
    fireEvent.click(await screen.findByTitle(/Search files/));
    const input = await screen.findByPlaceholderText(/Filter files/);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/Filter files/)).not.toBeInTheDocument();
    expect(await screen.findByText('Empty folder')).toBeInTheDocument();
  });

  it('debounces content search and shows hits', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(window.dw.grepFiles).mockResolvedValue([
        { path: `${ROOT}/a.ts`, line: 4, text: '  const x = 1  ' },
      ]);
      renderTree();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTitle(/Search files/));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const input = screen.getByPlaceholderText(/Filter files/);
      // Bare '>' is not a content query yet.
      fireEvent.change(input, { target: { value: '>' } });
      expect(screen.getByText('Type to search contents…')).toBeInTheDocument();
      expect(window.dw.grepFiles).not.toHaveBeenCalled();
      // Typing again before the debounce elapses cancels the earlier timer.
      fireEvent.change(input, { target: { value: '>foo' } });
      fireEvent.change(input, { target: { value: '>foobar' } });
      expect(screen.getByText('Searching…')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(window.dw.grepFiles).toHaveBeenCalledTimes(1);
      expect(window.dw.grepFiles).toHaveBeenCalledWith(ROOT, 'foobar', 200);
      expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
      fireEvent.click(screen.getByText(/const x = 1/));
      expect(screen.getByText(`EDITOR:${ROOT}/a.ts:4`)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the entry path on the drag payload', async () => {
    vi.mocked(window.dw.readDir).mockImplementation(async (dir: string) =>
      listing(dir, dir === ROOT ? [entry('notes.md', `${ROOT}/notes.md`, false, 3)] : []),
    );
    renderTree();
    const row = (await screen.findByText('notes.md')).closest('.dw-ft-row')!;
    const dt = {
      setData: vi.fn(),
      getData: vi.fn(() => ''),
      effectAllowed: '',
    } as unknown as DataTransfer;
    fireEvent.dragStart(row, { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith('application/x-dogwalker-file', `${ROOT}/notes.md`);
    expect(dt.setData).toHaveBeenCalledWith('text/plain', `${ROOT}/notes.md`);
  });
});
