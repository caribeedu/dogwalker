import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from './gitService';

const git = new GitService();

describe('GitService', () => {
  let repo: string;
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-git-'));
    run('init', '-b', 'main');
    run('config', 'user.email', 'test@dogwalker.dev');
    run('config', 'user.name', 'Test');
    run('config', 'commit.gpgsign', 'false');
    run('config', 'core.autocrlf', 'false');
    run('config', 'pull.rebase', 'false'); // divergent branches merge (not rebase)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    run('add', '-A');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('reports a real repo with its staged files', async () => {
    const s = await git.status(repo);
    expect(s.isRepo).toBe(true);
    expect(s.files.map((f) => f.path)).toContain('a.txt');
  });

  it('reports isRepo:false outside a repository', async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-nogit-'));
    try {
      expect((await git.status(notRepo)).isRepo).toBe(false);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it('commits and then sees a clean tree until a file is added', async () => {
    expect((await git.commit(repo, 'init')).ok).toBe(true);
    expect(await git.isClean(repo)).toBe(true);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
    expect(await git.isClean(repo)).toBe(false);
  });

  it('creates and checks out a branch, reflected in branches() and status()', async () => {
    await git.commit(repo, 'init');
    expect((await git.createBranch(repo, 'feature')).ok).toBe(true);
    expect((await git.checkout(repo, 'feature')).ok).toBe(true);
    expect((await git.status(repo)).branch).toBe('feature');
    expect(await git.branches(repo)).toContainEqual({ name: 'feature', current: true });
  });

  it('adds, lists and removes a worktree on a new branch', async () => {
    await git.commit(repo, 'init');
    const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-wt-')), 'featA');
    expect((await git.worktreeAdd(repo, wt, 'feat-a', true)).ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(true);
    expect(await git.worktreeList(repo)).toContainEqual(
      expect.objectContaining({ branch: 'feat-a' }),
    );
    expect((await git.worktreeRemove(repo, wt, true)).ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    fs.rmSync(path.dirname(wt), { recursive: true, force: true });
  });

  it('lands a clean floor branch and safely aborts a conflicting one', async () => {
    await git.commit(repo, 'init');
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-land-'));
    const at = (cwd: string) => (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

    // Clean land: a disjoint change on a floor branch merges into the ground.
    const floorA = path.join(wtRoot, 'featA');
    await git.worktreeAdd(repo, floorA, 'feat-a', true);
    fs.writeFileSync(path.join(floorA, 'only.txt'), 'from the floor');
    at(floorA)('add', '-A');
    at(floorA)('commit', '-m', 'add only.txt');
    expect((await git.merge(repo, 'feat-a')).ok).toBe(true);
    expect(fs.existsSync(path.join(repo, 'only.txt'))).toBe(true);

    // Conflict land: the same line diverges → merge fails and aborts cleanly.
    const floorB = path.join(wtRoot, 'featB');
    await git.worktreeAdd(repo, floorB, 'feat-b', true);
    fs.writeFileSync(path.join(floorB, 'a.txt'), 'floor-side');
    at(floorB)('add', '-A');
    at(floorB)('commit', '-m', 'floor edits a.txt');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ground-side');
    at(repo)('add', '-A');
    at(repo)('commit', '-m', 'ground edits a.txt');
    expect((await git.merge(repo, 'feat-b')).ok).toBe(false);
    expect((await git.mergeAbort(repo)).ok).toBe(true);
    expect(await git.isClean(repo)).toBe(true);
    const a = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');
    expect(a).toContain('ground-side');
    expect(a).not.toContain('<<<<<<<');

    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it('prunes worktree records whose directory was deleted outside git', async () => {
    await git.commit(repo, 'init');
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-prune-'));
    const wt = path.join(wtRoot, 'gone');
    await git.worktreeAdd(repo, wt, 'feat-r', true);
    fs.rmSync(wt, { recursive: true, force: true }); // vanished outside Dogwalker
    expect((await git.worktreePrune(repo)).ok).toBe(true);
    expect((await git.worktreeList(repo)).some((w) => w.branch === 'feat-r')).toBe(false);
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it('rejects a second worktree on an already-checked-out branch', async () => {
    await git.commit(repo, 'init');
    const branch = (await git.status(repo)).branch; // checked out at the repo root
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dup-'));
    const dup = await git.worktreeAdd(repo, path.join(wtRoot, 'dup'), branch, false);
    expect(dup.ok).toBe(false);
    expect(dup.output).toMatch(/already/i);
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it('parses ahead/behind against a remote and pushes, fetches and pulls', async () => {
    await git.commit(repo, 'init');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-bare-'));
    fs.rmSync(bare, { recursive: true, force: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
    try {
      run('remote', 'add', 'origin', bare);
      run('push', '-u', 'origin', 'main');
      expect((await git.push(repo)).ok).toBe(true);

      // Local commit beyond origin → ahead 1, behind 0.
      fs.writeFileSync(path.join(repo, 'ahead.txt'), 'extra');
      run('add', '-A');
      run('commit', '-m', 'local extra');
      let s = await git.status(repo);
      expect(s.branch).toBe('main');
      expect(s.ahead).toBe(1);
      expect(s.behind).toBe(0);

      // A second clone pushes a commit → we are now behind too.
      const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-clone-'));
      try {
        execFileSync('git', ['clone', '-q', bare, cloneDir]);
        const at = (cwd: string) => (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
        at(cloneDir)('config', 'user.email', 'clone@dogwalker.dev');
        at(cloneDir)('config', 'user.name', 'Clone');
        at(cloneDir)('config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(cloneDir, 'remote.txt'), 'from clone');
        at(cloneDir)('add', '-A');
        at(cloneDir)('commit', '-m', 'clone commit');
        at(cloneDir)('push');
      } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }

      expect((await git.fetch(repo)).ok).toBe(true);
      s = await git.status(repo);
      expect(s.ahead).toBe(1);
      expect(s.behind).toBe(1);
      expect((await git.pull(repo)).ok).toBe(true);
      s = await git.status(repo);
      expect(s.behind).toBe(0);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('logs commits with refs and parents, clamping the limit', async () => {
    await git.commit(repo, 'first');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
    run('add', '-A');
    run('commit', '-m', 'second');
    run('tag', 'v1');

    // limit 0 clamps to 1; a huge limit clamps to 2000 (no more commits exist).
    expect(await git.log(repo, 0)).toHaveLength(1);
    const all = await git.log(repo, 5000);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ subject: 'second', author: 'Test' });
    expect(all[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(all[0].time).toBeGreaterThan(0);
    expect(all[0].parents).toHaveLength(1);
    expect(all[0].refs).toContain('tag: v1');
    expect(all[1].parents).toEqual([]);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-nogit-'));
    try {
      expect(await git.log(empty, 10)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('diffs against HEAD, falling back to a plain diff in a fresh repo', async () => {
    await git.commit(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'modified-line');
    expect(await git.diff(repo)).toContain('modified-line');
    expect(await git.diff(repo, 'a.txt')).toContain('modified-line');

    // No commits yet → `diff HEAD` fails and the fallback takes over.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-fresh-'));
    try {
      execFileSync('git', ['init'], { cwd: fresh });
      fs.writeFileSync(path.join(fresh, 'f.txt'), 'original');
      execFileSync('git', ['add', '-A'], { cwd: fresh });
      fs.writeFileSync(path.join(fresh, 'f.txt'), 'changed');
      expect(await git.diff(fresh)).toContain('changed');
      expect(await git.diff(fresh, 'f.txt')).toContain('changed');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('stashes and pops working-tree changes', async () => {
    await git.commit(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty');
    expect((await git.stash(repo)).ok).toBe(true);
    expect(await git.isClean(repo)).toBe(true);
    expect((await git.stashPop(repo)).ok).toBe(true);
    expect(await git.isClean(repo)).toBe(false);
  });

  it('reports failure for ops in a repo without a remote', async () => {
    await git.commit(repo, 'init');
    expect((await git.pull(repo)).ok).toBe(false);
    expect((await git.push(repo)).ok).toBe(false);
  });

  it('deletes branches, requiring force for unmerged work', async () => {
    await git.commit(repo, 'init');
    await git.createBranch(repo, 'tmp');
    await git.checkout(repo, 'main');
    expect((await git.deleteBranch(repo, 'tmp', false)).ok).toBe(true);

    await git.createBranch(repo, 'gone');
    fs.writeFileSync(path.join(repo, 'g.txt'), 'g');
    run('add', '-A');
    run('commit', '-m', 'on gone');
    await git.checkout(repo, 'main');
    expect((await git.deleteBranch(repo, 'gone', false)).ok).toBe(false);
    expect((await git.deleteBranch(repo, 'gone', true)).ok).toBe(true);
  });

  it('summarizes a branch diff against its base', async () => {
    await git.commit(repo, 'init');
    await git.createBranch(repo, 'feature');
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature work');
    run('add', '-A');
    run('commit', '-m', 'feature');
    await git.checkout(repo, 'main');
    expect(await git.diffStat(repo, 'main', 'feature')).toContain('feat.txt');
  });

  it('reports empty results outside a repository', async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-nogit-'));
    try {
      expect(await git.branches(notRepo)).toEqual([]);
      expect(await git.worktreeList(notRepo)).toEqual([]);
      expect(await git.diffStat(notRepo, 'main', 'x')).toBe('');
      expect((await git.fetch(notRepo)).ok).toBe(false);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
