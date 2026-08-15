import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { GitDiffView } from './GitDiffView';

const SAMPLE_DIFF = [
  'diff --git a/src/app/App.tsx b/src/app/App.tsx',
  'index 1111111..2222222 100644',
  '--- a/src/app/App.tsx',
  '+++ b/src/app/App.tsx',
  '@@ -10,3 +10,4 @@ import { useState } from "react";',
  ' const App = () => {',
  '-const oldThing = 1;',
  '+const newThing = 2;',
  '  return null;',
  '};',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1,1 @@',
  '+# Dogwalker',
].join('\n');

function renderDiff(cwd = '/repo', reloadKey = 1) {
  return render(<GitDiffView cwd={cwd} reloadKey={reloadKey} />);
}

describe('GitDiffView', () => {
  beforeEach(() => {
    window.dw = {
      gitDiff: vi.fn(),
    } as unknown as typeof window.dw;
  });

  it('shows the loading state while the diff is being fetched', () => {
    vi.mocked(window.dw.gitDiff).mockImplementation(() => new Promise<string>(() => {}));
    renderDiff();
    expect(screen.getByText('Loading diff…')).toBeInTheDocument();
  });

  it('renders files, hunks, deletions, additions and context rows', async () => {
    vi.mocked(window.dw.gitDiff).mockResolvedValue(SAMPLE_DIFF);
    renderDiff();
    expect(await screen.findByText('src/app/App.tsx')).toBeInTheDocument();
    expect(window.dw.gitDiff).toHaveBeenCalledWith('/repo');

    // Hunk header renders its raw text.
    expect(screen.getByText('@@ -10,3 +10,4 @@ import { useState } from "react";')).toBeInTheDocument();
    // A pure addition file (README.md) shows its added line on the new side.
    expect(screen.getByText('# Dogwalker')).toBeInTheDocument();
    // Deleted and added lines from App.tsx.
    expect(screen.getByText('const oldThing = 1;')).toBeInTheDocument();
    expect(screen.getByText('const newThing = 2;')).toBeInTheDocument();
    // Context line appears on both sides.
    expect(screen.getAllByText('const App = () => {').length).toBe(2);
  });

  it('shows an empty state when there are no uncommitted changes', async () => {
    vi.mocked(window.dw.gitDiff).mockResolvedValue('');
    renderDiff();
    expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument();
  });

  it('shows an error state when the diff request rejects', async () => {
    vi.mocked(window.dw.gitDiff).mockRejectedValue(new Error('not a repo'));
    renderDiff();
    expect(await screen.findByText(/Could not load diff/)).toBeInTheDocument();
    expect(screen.getByText(/not a repo/)).toBeInTheDocument();
  });

  it('collapses and expands a file on header click', async () => {
    vi.mocked(window.dw.gitDiff).mockResolvedValue(SAMPLE_DIFF);
    const { container } = renderDiff();
    await screen.findByText('src/app/App.tsx');
    expect(container.querySelector('.dw-ft-caret')).toHaveTextContent('▾');

    fireEvent.click(screen.getByText('src/app/App.tsx'));
    expect(container.querySelector('.dw-ft-caret')).toHaveTextContent('▸');
    expect(screen.queryByText('const oldThing = 1;')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('src/app/App.tsx'));
    expect(container.querySelector('.dw-ft-caret')).toHaveTextContent('▾');
    expect(screen.getByText('const oldThing = 1;')).toBeInTheDocument();
  });

  it('collapses each file independently', async () => {
    vi.mocked(window.dw.gitDiff).mockResolvedValue(SAMPLE_DIFF);
    const { container } = renderDiff();
    await screen.findByText('src/app/App.tsx');
    fireEvent.click(screen.getByText('src/app/App.tsx'));
    // README body still visible while App.tsx is collapsed.
    expect(screen.getByText('# Dogwalker')).toBeInTheDocument();
    const carets = container.querySelectorAll('.dw-ft-caret');
    expect(carets[0]).toHaveTextContent('▸');
    expect(carets[1]).toHaveTextContent('▾');
  });

  it('re-fetches the diff when the reload key changes', async () => {
    vi.mocked(window.dw.gitDiff).mockResolvedValue(SAMPLE_DIFF);
    const { rerender } = renderDiff('/repo', 1);
    await screen.findByText('src/app/App.tsx');
    rerender(<GitDiffView cwd="/repo" reloadKey={2} />);
    await waitFor(() => expect(window.dw.gitDiff).toHaveBeenCalledTimes(2));
  });

  it('does not set state after unmount while the diff is in flight', async () => {
    vi.mocked(window.dw.gitDiff).mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(SAMPLE_DIFF), 10)),
    );
    const { unmount } = renderDiff();
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(window.dw.gitDiff).toHaveBeenCalledTimes(1);
  });
});
