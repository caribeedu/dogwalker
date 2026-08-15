import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { FloorMeta } from '../shared/ipc';
import { FloorBar } from './FloorBar';

function makeFloor(overrides: Partial<FloorMeta> = {}): FloorMeta {
  return { id: 'f1', name: 'floor-a', branch: 'feat/a', path: '/tmp/ws/f1', ...overrides };
}

const floorA = makeFloor();
const floorB = makeFloor({ id: 'f2', name: 'floor-b', branch: 'feat/b', path: '/tmp/ws/f2' });

interface Harness {
  onSwitch: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  container: HTMLElement;
  unmount: () => void;
}

function renderFloorBar(floors: FloorMeta[] = [floorA], activeFloor = 'ground'): Harness {
  const onSwitch = vi.fn();
  const onChanged = vi.fn();
  const { container, unmount } = render(
    <FloorBar
      workspaceId="ws1"
      floors={floors}
      activeFloor={activeFloor}
      onSwitch={onSwitch}
      onChanged={onChanged}
    />,
  );
  return { onSwitch, onChanged, container, unmount };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FloorBar', () => {
  beforeEach(() => {
    window.dw = {
      runFloorHook: vi.fn(),
      removeFloor: vi.fn(),
      landInfo: vi.fn(),
      land: vi.fn(),
      repoBranches: vi.fn(),
      createFloor: vi.fn(),
    } as unknown as typeof window.dw;
    vi.spyOn(window, 'confirm').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the ground chip and every floor chip with branch labels', () => {
    const { container } = renderFloorBar([floorA, floorB], 'f1');
    expect(screen.getByRole('button', { name: /Ground/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /floor-a/ })).toHaveTextContent('feat/a');
    expect(screen.getByRole('button', { name: /floor-b/ })).toHaveTextContent('feat/b');
    expect(container.querySelectorAll('.dw-floor-chip')).toHaveLength(3);
    expect(container.querySelectorAll('.dw-floor-chip-wrap')).toHaveLength(2);
  });

  it('marks the active floor chip as active', () => {
    const { container } = renderFloorBar([floorA, floorB], 'f2');
    const wraps = container.querySelectorAll('.dw-floor-chip-wrap');
    expect(wraps[1].className).toContain('active');
    expect(wraps[0].className).not.toContain('active');
    const ground = screen.getByRole('button', { name: /Ground/ });
    expect(ground.className).not.toContain('active');
  });

  it('marks ground active and no floor when activeFloor is ground', () => {
    const { container } = renderFloorBar([floorA], 'ground');
    expect(screen.getByRole('button', { name: /Ground/ }).className).toContain('active');
    expect(container.querySelector('.dw-floor-chip-wrap')?.className).not.toContain('active');
  });

  it('renders only ground and the add button when there are no floors', () => {
    renderFloorBar([]);
    expect(screen.getByRole('button', { name: /Ground/ })).toBeInTheDocument();
    expect(screen.getByTitle('New floor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /floor-/ })).not.toBeInTheDocument();
  });

  it('switches to ground when the ground chip is clicked', () => {
    const { onSwitch } = renderFloorBar([floorA], 'f1');
    fireEvent.click(screen.getByRole('button', { name: /Ground/ }));
    expect(onSwitch).toHaveBeenCalledWith('ground');
  });

  it('switches to a floor when its chip is clicked', () => {
    const { onSwitch } = renderFloorBar([floorA, floorB], 'ground');
    fireEvent.click(screen.getByRole('button', { name: /floor-b/ }));
    expect(onSwitch).toHaveBeenCalledWith('f2');
  });

  it('runs the hook and shows the ok output in a dialog', async () => {
    vi.mocked(window.dw.runFloorHook).mockResolvedValue({ ran: true, ok: true, output: 'build ok' });
    const { onSwitch, onChanged } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Run this project/));
    expect(window.dw.runFloorHook).toHaveBeenCalledWith('ws1', 'f1');
    expect(await screen.findByText('Run hook · floor-a')).toBeInTheDocument();
    expect(screen.getByText('build ok')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows … and disables the run button while the hook is running', async () => {
    const d = deferred<{ ran: boolean; ok: boolean; output: string }>();
    vi.mocked(window.dw.runFloorHook).mockReturnValue(d.promise);
    renderFloorBar([floorA], 'ground');
    const run = screen.getByTitle(/Run this project/);
    fireEvent.click(run);
    expect(run).toBeDisabled();
    expect(run).toHaveTextContent('…');
    await act(async () => {
      d.resolve({ ran: true, ok: true, output: 'x' });
    });
    expect(await screen.findByText('Run hook · floor-a')).toBeInTheDocument();
  });

  it('shows an error state when the hook result is not ok', async () => {
    vi.mocked(window.dw.runFloorHook).mockResolvedValue({ ran: true, ok: false, output: 'boom' });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Run this project/));
    await screen.findByText('Run hook · floor-a');
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('heading').querySelector('.dw-hook-err')).toBeInTheDocument();
  });

  it('shows "(no output)" when the hook output is empty', async () => {
    vi.mocked(window.dw.runFloorHook).mockResolvedValue({ ran: false, ok: true, output: '' });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Run this project/));
    expect(await screen.findByText('(no output)')).toBeInTheDocument();
  });

  it('closes the hook dialog with the Close button', async () => {
    vi.mocked(window.dw.runFloorHook).mockResolvedValue({ ran: true, ok: true, output: 'x' });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Run this project/));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByText('Run hook · floor-a')).not.toBeInTheDocument();
    });
  });

  it('closes the hook dialog when the scrim is clicked, not the dialog body', async () => {
    vi.mocked(window.dw.runFloorHook).mockResolvedValue({ ran: true, ok: true, output: 'x' });
    const { container } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Run this project/));
    const dialog = await screen.findByText('Run hook · floor-a');
    // Clicking inside the dialog body must not close it.
    fireEvent.click(dialog);
    expect(screen.getByText('Run hook · floor-a')).toBeInTheDocument();
    // Clicking the scrim closes it.
    fireEvent.click(container.querySelector('.dw-floor-dialog-scrim') as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByText('Run hook · floor-a')).not.toBeInTheDocument();
    });
  });

  it('does not delete the floor when confirm is refused', () => {
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('Delete this floor (removes its worktree)'));
    expect(window.confirm).toHaveBeenCalledWith('Delete floor "floor-a"? Its worktree is removed.');
    expect(window.dw.removeFloor).not.toHaveBeenCalled();
  });

  it('deletes an active floor and switches to ground', async () => {
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.mocked(window.dw.removeFloor).mockResolvedValue({ ok: true });
    const { onSwitch, onChanged } = renderFloorBar([floorA], 'f1');
    fireEvent.click(screen.getByTitle('Delete this floor (removes its worktree)'));
    expect(window.dw.removeFloor).toHaveBeenCalledWith('ws1', 'f1', false);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onSwitch).toHaveBeenCalledWith('ground');
  });

  it('deletes an inactive floor without switching', async () => {
    vi.mocked(window.confirm).mockReturnValue(true);
    vi.mocked(window.dw.removeFloor).mockResolvedValue({ ok: true });
    const { onSwitch, onChanged } = renderFloorBar([floorA, floorB], 'f2');
    fireEvent.click(screen.getAllByTitle('Delete this floor (removes its worktree)')[0]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('opens the create dialog from the add button', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main', 'dev']);
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    expect(await screen.findByRole('heading', { name: 'New floor' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    // First branch is pre-selected for the new-branch name field.
    expect(screen.getByPlaceholderText(/new branch name/)).toHaveValue('main');
  });

  it('creates a floor with a new branch and calls onCreated', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    vi.mocked(window.dw.createFloor).mockResolvedValue({
      ok: true,
      floor: { id: 'f9', name: 'alpha', branch: 'main', path: '/tmp/ws/f9' },
      setup: { ran: false, ok: true, output: '' },
    });
    const { onSwitch, onChanged } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(window.dw.createFloor).toHaveBeenCalledWith('ws1', {
      name: 'alpha',
      branch: 'main',
      createBranch: true,
      cloneGround: false,
    });
    expect(onSwitch).toHaveBeenCalledWith('f9');
    // setup.ran is false -> no setup-hook dialog.
    expect(screen.queryByText('Setup hook')).not.toBeInTheDocument();
    // Dialog closes after creation.
    expect(screen.queryByRole('heading', { name: 'New floor' })).not.toBeInTheDocument();
  });

  it('defaults the branch to the floor name when the branch field is blank', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue([]);
    vi.mocked(window.dw.createFloor).mockResolvedValue({
      ok: true,
      floor: { id: 'f9', name: 'alpha', branch: 'alpha', path: '/tmp/ws/f9' },
    });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByPlaceholderText(/new branch name/), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    await waitFor(() =>
      expect(window.dw.createFloor).toHaveBeenCalledWith('ws1', {
        name: 'alpha',
        branch: 'alpha',
        createBranch: true,
        cloneGround: false,
      }),
    );
  });

  it('creates a floor on an existing branch and clones the ground layout', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main', 'dev']);
    vi.mocked(window.dw.createFloor).mockResolvedValue({
      ok: true,
      floor: { id: 'f9', name: 'beta', branch: 'dev', path: '/tmp/ws/f9' },
    });
    const { onSwitch } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'beta' } });
    fireEvent.click(screen.getByLabelText('Existing'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'dev' } });
    // Toggle back to New branch — the mode radio handlers must both work.
    fireEvent.click(screen.getByLabelText('New branch'));
    expect(screen.getByPlaceholderText(/new branch name/)).toHaveValue('dev');
    fireEvent.click(screen.getByLabelText('Existing'));
    fireEvent.click(screen.getByLabelText(/Clone the ground layout/));
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    await waitFor(() =>
      expect(window.dw.createFloor).toHaveBeenCalledWith('ws1', {
        name: 'beta',
        branch: 'dev',
        createBranch: false,
        cloneGround: true,
      }),
    );
    expect(onSwitch).toHaveBeenCalledWith('f9');
  });

  it('rejects an empty name with an inline error', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    expect(await screen.findByText('Name the floor.')).toBeInTheDocument();
    expect(window.dw.createFloor).not.toHaveBeenCalled();
  });

  it('requires a branch in existing mode when none are available', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue([]);
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'beta' } });
    fireEvent.click(screen.getByLabelText('Existing'));
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    expect(await screen.findByText('Pick or name a branch.')).toBeInTheDocument();
    expect(window.dw.createFloor).not.toHaveBeenCalled();
  });

  it('surfaces the ipc error when createFloor fails', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    vi.mocked(window.dw.createFloor).mockResolvedValue({ ok: false, error: 'branch exists' });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    expect(await screen.findByText('branch exists')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New floor' })).toBeInTheDocument();
  });

  it('falls back to a generic message when createFloor fails without an error', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    vi.mocked(window.dw.createFloor).mockResolvedValue({ ok: false, floor: undefined });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    expect(await screen.findByText('Could not create the floor.')).toBeInTheDocument();
  });

  it('shows the setup-hook dialog when createFloor ran a setup hook', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    vi.mocked(window.dw.createFloor).mockResolvedValue({
      ok: true,
      floor: { id: 'f9', name: 'alpha', branch: 'main', path: '/tmp/ws/f9' },
      setup: { ran: true, ok: true, output: 'installed deps' },
    });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create floor' }));
    expect(await screen.findByText('Setup hook')).toBeInTheDocument();
    expect(screen.getByText('installed deps')).toBeInTheDocument();
  });

  it('shows Creating… while createFloor is pending', async () => {
    const d = deferred<{ ok: boolean; floor?: FloorMeta }>();
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    vi.mocked(window.dw.createFloor).mockReturnValue(d.promise);
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'alpha' } });
    const create = screen.getByRole('button', { name: 'Create floor' });
    fireEvent.click(create);
    expect(create).toBeDisabled();
    expect(create).toHaveTextContent('Creating…');
    await act(async () => {
      d.resolve({ ok: true, floor: floorA });
    });
  });

  it('closes the create dialog with Cancel and via the scrim', async () => {
    vi.mocked(window.dw.repoBranches).mockResolvedValue(['main']);
    const { container } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'New floor' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('New floor'));
    await screen.findByRole('heading', { name: 'New floor' });
    fireEvent.click(container.querySelector('.dw-floor-dialog-scrim') as HTMLElement);
    expect(screen.queryByRole('heading', { name: 'New floor' })).not.toBeInTheDocument();
    expect(window.dw.createFloor).not.toHaveBeenCalled();
  });

  it('opens the land dialog and shows the checking state until info loads', async () => {
    const d = deferred<{
      floorBranch: string;
      groundBranch: string;
      branches: string[];
      diffStat: string;
      floorClean: boolean;
      groundClean: boolean;
    }>();
    vi.mocked(window.dw.landInfo).mockReturnValue(d.promise);
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    expect(await screen.findByRole('heading', { name: /Land “floor-a”/ })).toBeInTheDocument();
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    await act(async () => {
      d.resolve({
        floorBranch: 'feat/a',
        groundBranch: 'main',
        branches: ['main', 'feat/a'],
        diffStat: '1 file changed',
        floorClean: true,
        groundClean: true,
      });
    });
    expect(await screen.findByText('1 file changed')).toBeInTheDocument();
  });

  it('lands the floor into the chosen target branch and fires onLanded', async () => {
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a', 'other'],
      diffStat: '1 file changed',
      floorClean: true,
      groundClean: true,
    });
    vi.mocked(window.dw.land).mockResolvedValue({ ok: true });
    const { onSwitch, onChanged } = renderFloorBar([floorA], 'f1');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    await screen.findByText('1 file changed');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(window.dw.land).toHaveBeenCalledWith('ws1', 'f1', {
      targetBranch: 'other',
      deleteBranch: true,
    });
    expect(onSwitch).toHaveBeenCalledWith('ground');
    expect(screen.queryByRole('heading', { name: /Land “floor-a”/ })).not.toBeInTheDocument();
  });

  it('unchecks delete-branch and passes it through to land', async () => {
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a'],
      diffStat: '',
      floorClean: true,
      groundClean: true,
    });
    vi.mocked(window.dw.land).mockResolvedValue({ ok: true });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    expect(await screen.findByText('(no differences from the target)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Delete branch/));
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
    await waitFor(() =>
      expect(window.dw.land).toHaveBeenCalledWith('ws1', 'f1', {
        targetBranch: 'main',
        deleteBranch: false,
      }),
    );
  });

  it('disables Land and warns when the floor or ground is dirty', async () => {
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a'],
      diffStat: 'x',
      floorClean: false,
      groundClean: false,
    });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    expect(
      await screen.findByText(
        'The floor has uncommitted changes — commit or discard them first.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('The ground has uncommitted changes — commit or discard them first.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Land' })).toBeDisabled();
    expect(window.dw.land).not.toHaveBeenCalled();
  });

  it('shows the landing stage and error when land fails', async () => {
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a'],
      diffStat: 'x',
      floorClean: true,
      groundClean: true,
    });
    vi.mocked(window.dw.land).mockResolvedValue({ ok: false, stage: 'merge', error: 'conflict' });
    const { onChanged } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    await screen.findByText('x');
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
    expect(await screen.findByText('merge: conflict')).toBeInTheDocument();
    // Dialog stays open on failure.
    expect(screen.getByRole('heading', { name: /Land “floor-a”/ })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('falls back to failed: when land fails without stage or error', async () => {
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a'],
      diffStat: 'x',
      floorClean: true,
      groundClean: true,
    });
    vi.mocked(window.dw.land).mockResolvedValue({ ok: false });
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    await screen.findByText('x');
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
    expect(await screen.findByText('failed:')).toBeInTheDocument();
  });

  it('shows Landing… while the land operation is pending', async () => {
    const d = deferred<{ ok: boolean }>();
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a'],
      diffStat: 'x',
      floorClean: true,
      groundClean: true,
    });
    vi.mocked(window.dw.land).mockReturnValue(d.promise);
    renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    await screen.findByText('x');
    const land = screen.getByRole('button', { name: 'Land' });
    fireEvent.click(land);
    expect(land).toBeDisabled();
    expect(land).toHaveTextContent('Landing…');
    await act(async () => {
      d.resolve({ ok: true });
    });
  });

  it('closes the land dialog with Cancel and via the scrim', async () => {
    vi.mocked(window.dw.landInfo).mockResolvedValue({
      floorBranch: 'feat/a',
      groundBranch: 'main',
      branches: ['main', 'feat/a'],
      diffStat: 'x',
      floorClean: true,
      groundClean: true,
    });
    const { container } = renderFloorBar([floorA], 'ground');
    fireEvent.click(screen.getByTitle(/Land this floor/));
    await screen.findByText('x');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: /Land “floor-a”/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Land this floor/));
    await screen.findByText('x');
    fireEvent.click(container.querySelector('.dw-floor-dialog-scrim') as HTMLElement);
    expect(screen.queryByRole('heading', { name: /Land “floor-a”/ })).not.toBeInTheDocument();
    expect(window.dw.land).not.toHaveBeenCalled();
  });
});
