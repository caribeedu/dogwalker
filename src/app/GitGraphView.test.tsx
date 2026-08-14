import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { GitCommit } from '../shared/ipc';
import { GitGraphView } from './GitGraphView';

function commit(
  hash: string,
  parents: string[],
  subject: string,
  refs: string[] = [],
  author = 'Ada',
): GitCommit {
  return { hash, parents, refs, author, subject, time: 1700000000 };
}

// c3 (HEAD -> main) merges feature branch b1; c2 is main's previous commit.
const LOG: GitCommit[] = [
  commit('c3abc12', ['c2ghi56', 'b1def34'], 'Merge feature', ['HEAD -> main', 'tag: v2']),
  commit('b1def34', ['c1jkl78'], 'Add widget', ['feature']),
  commit('c2ghi56', ['c1jkl78'], 'Fix bug', []),
  commit('c1jkl78', [], 'Initial commit', ['v1.0']),
];

describe('GitGraphView', () => {
  beforeEach(() => {
    window.dw = {
      gitLog: vi.fn(),
    } as unknown as typeof window.dw;
  });

  it('shows the empty state before any commits arrive', () => {
    vi.mocked(window.dw.gitLog).mockResolvedValue([]);
    render(<GitGraphView cwd="/repo" />);
    expect(screen.getByText('No commits.')).toBeInTheDocument();
  });

  it('shows an error state when the log request rejects', async () => {
    vi.mocked(window.dw.gitLog).mockRejectedValue(new Error('repo gone'));
    render(<GitGraphView cwd="/repo" />);
    expect(await screen.findByText(/Could not load history/)).toBeInTheDocument();
    expect(screen.getByText(/repo gone/)).toBeInTheDocument();
  });

  it('renders a commit row with subject, author and short hash', async () => {
    vi.mocked(window.dw.gitLog).mockResolvedValue(LOG);
    render(<GitGraphView cwd="/repo" />);
    expect(window.dw.gitLog).toHaveBeenCalledWith('/repo', 300);
    expect(await screen.findByText('Merge feature')).toBeInTheDocument();
    expect(screen.getByText('Fix bug')).toBeInTheDocument();
    expect(screen.getAllByText('Ada').length).toBe(4);
    // Hash rendered as 7 chars.
    expect(screen.getByText('c3abc12')).toBeInTheDocument();
    expect(screen.getByText('b1def34')).toBeInTheDocument();
    expect(screen.getByText('Initial commit')).toBeInTheDocument();
  });

  it('strips the HEAD -> prefix from refs', async () => {
    vi.mocked(window.dw.gitLog).mockResolvedValue(LOG);
    render(<GitGraphView cwd="/repo" />);
    expect(await screen.findByText('Merge feature')).toBeInTheDocument();
    expect(screen.queryByText('HEAD -> main')).not.toBeInTheDocument();
    expect(screen.getByText('feature')).toBeInTheDocument();
    expect(screen.getByText('tag: v2')).toBeInTheDocument();
    // Only c3 carries the main ref after stripping, so exactly one element.
    expect(screen.getAllByText('main').length).toBe(1);
  });

  it('draws lane segments when the history branches', async () => {
    vi.mocked(window.dw.gitLog).mockResolvedValue(LOG);
    const { container } = render(<GitGraphView cwd="/repo" />);
    await screen.findByText('Merge feature');
    const paths = container.querySelectorAll('.dw-git-graph-svg path');
    const circles = container.querySelectorAll('.dw-git-graph-svg circle');
    // Merge commit produces a branch-out segment; every row has a dot.
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(circles.length).toBe(4);
  });

  it('sizes the svg from the widest row', async () => {
    vi.mocked(window.dw.gitLog).mockResolvedValue(LOG);
    const { container } = render(<GitGraphView cwd="/repo" />);
    await screen.findByText('Merge feature');
    const svg = container.querySelector('.dw-git-graph-svg')!;
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(14);
    expect(Number(svg.getAttribute('height'))).toBe(26);
  });

  it('renders a lone commit without parents', async () => {
    vi.mocked(window.dw.gitLog).mockResolvedValue([commit('c1', [], 'Only commit', ['main'])]);
    const { container } = render(<GitGraphView cwd="/repo" />);
    expect(await screen.findByText('Only commit')).toBeInTheDocument();
    expect(container.querySelectorAll('.dw-git-graph-svg circle').length).toBe(1);
    expect(container.querySelectorAll('.dw-git-graph-svg path').length).toBe(0);
  });

  it('does not set state after unmount while the log is in flight', async () => {
    vi.mocked(window.dw.gitLog).mockImplementation(
      () => new Promise<GitCommit[]>((resolve) => setTimeout(() => resolve(LOG), 10)),
    );
    const { unmount } = render(<GitGraphView cwd="/repo" />);
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(window.dw.gitLog).toHaveBeenCalledTimes(1);
  });
});
