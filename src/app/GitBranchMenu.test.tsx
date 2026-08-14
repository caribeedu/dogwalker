import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { GitBranch, GitResult, GitStatus } from '../shared/ipc';
import { GitBranchMenu } from './GitBranchMenu';

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return { isRepo: true, branch: 'main', ahead: 0, behind: 0, files: [], ...overrides };
}

function branches(list: Array<[string, boolean]>): GitBranch[] {
  return list.map(([name, current]) => ({ name, current }));
}

function renderMenu(overrides: { cwd?: string; status?: GitStatus } = {}) {
  const props = {
    cwd: '/repo',
    status: status(),
    onClose: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <GitBranchMenu
      cwd={props.cwd}
      status={props.status}
      onClose={props.onClose}
      onChanged={props.onChanged}
    />,
  );
  return { ...utils, onClose: props.onClose, onChanged: props.onChanged };
}

/** Flush pending promises so effects/actions settle. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('GitBranchMenu', () => {
  beforeEach(() => {
    window.dw = {
      gitBranches: vi.fn(),
      gitCheckout: vi.fn(),
      gitMerge: vi.fn(),
      gitCommit: vi.fn(),
      gitCreateBranch: vi.fn(),
      gitFetch: vi.fn(),
      gitPull: vi.fn(),
      gitPush: vi.fn(),
      gitStash: vi.fn(),
      gitStashPop: vi.fn(),
    } as unknown as typeof window.dw;
    vi.mocked(window.dw.gitBranches).mockResolvedValue(
      branches([
        ['main', true],
        ['feature/x', false],
      ]),
    );
  });

  it('lists branches, marking the current one', async () => {
    renderMenu();
    const feature = await screen.findByRole('button', { name: /feature\/x/ });
    expect(feature).toBeInTheDocument();
    const main = screen.getByRole('button', { name: /● main/ });
    expect(main).toBeDisabled();
    expect(feature).toBeEnabled();
    expect(window.dw.gitBranches).toHaveBeenCalledWith('/repo');
  });

  it('shows branch status: ahead, behind and changed files', async () => {
    renderMenu({ status: status({ branch: 'dev', ahead: 3, behind: 1, files: [{ path: 'a.ts', index: 'M', work: 'M' }] }) });
    expect(await screen.findByText(/on/)).toBeInTheDocument();
    expect(screen.getByText('dev')).toBeInTheDocument();
    expect(screen.getByText('↑3')).toBeInTheDocument();
    expect(screen.getByText('↓1')).toBeInTheDocument();
    expect(screen.getByText('1 changed')).toBeInTheDocument();
  });

  it('shows "detached" when on no branch', async () => {
    renderMenu({ status: status({ branch: '' }) });
    expect(await screen.findByText('detached')).toBeInTheDocument();
  });

  it('checks out a branch and surfaces the result', async () => {
    vi.mocked(window.dw.gitCheckout).mockResolvedValue({ ok: true, output: 'Switched to branch feature/x' });
    const { onChanged } = renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /○ feature\/x/ }));
    expect(await screen.findByText('Switched to branch feature/x')).toBeInTheDocument();
    expect(window.dw.gitCheckout).toHaveBeenCalledWith('/repo', 'feature/x');
    expect(onChanged).toHaveBeenCalledTimes(1);
    // A mutation re-triggers the branch list refresh.
    expect(window.dw.gitBranches).toHaveBeenCalledTimes(2);
  });

  it('does not check out the current branch', async () => {
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /● main/ }));
    await flush();
    expect(window.dw.gitCheckout).not.toHaveBeenCalled();
  });

  it('shows git output for a failed operation', async () => {
    vi.mocked(window.dw.gitCheckout).mockResolvedValue({ ok: false, output: 'error: pathspec did not match' });
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /○ feature\/x/ }));
    const result = await screen.findByText('error: pathspec did not match');
    expect(result.className).toContain('err');
  });

  it('falls back to "Failed." for an empty failed result', async () => {
    vi.mocked(window.dw.gitCheckout).mockResolvedValue({ ok: false, output: '' });
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /○ feature\/x/ }));
    expect(await screen.findByText('Failed.')).toBeInTheDocument();
  });

  it('falls back to "Done." for an empty successful result', async () => {
    vi.mocked(window.dw.gitCheckout).mockResolvedValue({ ok: true, output: '' });
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /○ feature\/x/ }));
    expect(await screen.findByText('Done.')).toBeInTheDocument();
  });

  it('merges a branch in merge mode', async () => {
    vi.mocked(window.dw.gitMerge).mockResolvedValue({ ok: true, output: 'Merge made by the "ort" strategy.' });
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /Merge/ }));
    expect(screen.getByText('Pick a branch to merge in:')).toBeInTheDocument();
    // Current branch is clickable in merge mode.
    fireEvent.click(screen.getByRole('button', { name: /● main/ }));
    expect(await screen.findByText('Merge made by the "ort" strategy.')).toBeInTheDocument();
    expect(window.dw.gitMerge).toHaveBeenCalledWith('/repo', 'main');
    expect(window.dw.gitCheckout).not.toHaveBeenCalled();
    // Merge mode turns back off after a pick.
    expect(screen.queryByText('Pick a branch to merge in:')).not.toBeInTheDocument();
  });

  it('toggles merge mode off with the same button', async () => {
    renderMenu();
    const mergeBtn = await screen.findByRole('button', { name: /Merge/ });
    fireEvent.click(mergeBtn);
    expect(screen.getByText('Pick a branch to merge in:')).toBeInTheDocument();
    fireEvent.click(mergeBtn);
    expect(screen.queryByText('Pick a branch to merge in:')).not.toBeInTheDocument();
  });

  it('commits from the prompt via Enter', async () => {
    vi.mocked(window.dw.gitCommit).mockResolvedValue({ ok: true, output: '[main abc1234] fix: things' });
    const { onChanged } = renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /Commit/ }));
    const input = screen.getByPlaceholderText('Commit message');
    fireEvent.change(input, { target: { value: 'fix: things' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('[main abc1234] fix: things')).toBeInTheDocument();
    expect(window.dw.gitCommit).toHaveBeenCalledWith('/repo', 'fix: things');
    expect(onChanged).toHaveBeenCalledTimes(1);
    // Prompt is dismissed and draft cleared.
    expect(screen.queryByPlaceholderText('Commit message')).not.toBeInTheDocument();
  });

  it('creates a branch from the prompt via OK', async () => {
    vi.mocked(window.dw.gitCreateBranch).mockResolvedValue({ ok: true, output: 'Switched to a new branch fix-1' });
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /New branch/ }));
    const input = screen.getByPlaceholderText('New branch name');
    fireEvent.change(input, { target: { value: '  fix-1  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByText('Switched to a new branch fix-1')).toBeInTheDocument();
    // Input is trimmed before the call.
    expect(window.dw.gitCreateBranch).toHaveBeenCalledWith('/repo', 'fix-1');
  });

  it('ignores an empty prompt submission', async () => {
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /Commit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await flush();
    expect(window.dw.gitCommit).not.toHaveBeenCalled();
  });

  it('cancels the prompt with Escape or the Cancel button', async () => {
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /Commit/ }));
    const input = screen.getByPlaceholderText('Commit message');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Commit message')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New branch/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('New branch name')).not.toBeInTheDocument();
    expect(window.dw.gitCommit).not.toHaveBeenCalled();
    expect(window.dw.gitCreateBranch).not.toHaveBeenCalled();
  });

  it('runs fetch, pull, push, stash and stash pop through git', async () => {
    const ok: GitResult = { ok: true, output: 'ok' };
    vi.mocked(window.dw.gitFetch).mockResolvedValue(ok);
    vi.mocked(window.dw.gitPull).mockResolvedValue(ok);
    vi.mocked(window.dw.gitPush).mockResolvedValue(ok);
    vi.mocked(window.dw.gitStash).mockResolvedValue(ok);
    vi.mocked(window.dw.gitStashPop).mockResolvedValue(ok);
    renderMenu();
    await screen.findByRole('button', { name: 'Fetch' });

    // Each click disables the buttons until the op settles, so sequence them.
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    await waitFor(() => expect(window.dw.gitFetch).toHaveBeenCalledWith('/repo'));
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(window.dw.gitPull).toHaveBeenCalledWith('/repo'));
    fireEvent.click(screen.getByRole('button', { name: 'Push' }));
    await waitFor(() => expect(window.dw.gitPush).toHaveBeenCalledWith('/repo'));
    fireEvent.click(screen.getByRole('button', { name: 'Stash' }));
    await waitFor(() => expect(window.dw.gitStash).toHaveBeenCalledWith('/repo'));
    fireEvent.click(screen.getByRole('button', { name: 'Stash pop' }));
    await waitFor(() => expect(window.dw.gitStashPop).toHaveBeenCalledWith('/repo'));
  });

  it('disables every action while an operation is in flight', async () => {
    let resolveFetch!: (r: GitResult) => void;
    vi.mocked(window.dw.gitFetch).mockImplementation(
      () => new Promise<GitResult>((resolve) => { resolveFetch = resolve; }),
    );
    renderMenu();
    await screen.findByRole('button', { name: /Fetch/ });

    fireEvent.click(screen.getByRole('button', { name: /Fetch/ }));
    expect(screen.getByRole('button', { name: /Fetch/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /○ feature\/x/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Merge/ })).toBeDisabled();

    await act(async () => {
      resolveFetch({ ok: true, output: 'Already up to date.' });
    });
    expect(screen.getByRole('button', { name: /Fetch/ })).toBeEnabled();
    expect(screen.getByText('Already up to date.')).toBeInTheDocument();
  });

  it('closes the menu via the close button', async () => {
    const { onClose } = renderMenu();
    fireEvent.click(await screen.findByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops click propagation on the menu container', async () => {
    renderMenu();
    await screen.findByRole('button', { name: 'Fetch' });
    // React's delegated listener lives on the root container; a click that is
    // stopPropagation'd inside must never bubble up to document.body.
    const spy = vi.fn();
    document.body.addEventListener('click', spy);
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }));
    expect(spy).not.toHaveBeenCalled();
    document.body.removeEventListener('click', spy);
  });
});
