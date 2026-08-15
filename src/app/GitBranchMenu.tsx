import { useEffect, useState } from 'react';
import type { GitBranch, GitResult, GitStatus } from '../shared/ipc';

interface Props {
  cwd: string;
  status: GitStatus;
  onClose: () => void;
  /** Called after any mutation so the node can refresh status + views. */
  onChanged: () => void;
}

type PromptKind = 'commit' | 'branch' | null;

/**
 * The branch indicator's dropdown (PRODUCT.md §8): switch branches and run the
 * everyday git operations (commit, fetch/pull/push, new branch, merge, stash)
 * against the File Tree's repo. Each action surfaces git's own output so a
 * failure — merge conflict, no upstream — is visible rather than silent.
 */
export function GitBranchMenu({ cwd, status, onClose, onChanged }: Props) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [result, setResult] = useState<GitResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<PromptKind>(null);
  const [draft, setDraft] = useState('');
  const [mergeMode, setMergeMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.dw
      .gitBranches(cwd)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        setError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not list branches: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, result]);

  const act = async (fn: () => Promise<GitResult>) => {
    setBusy(true);
    try {
      const r = await fn();
      setResult(r);
      onChanged();
    } catch (err) {
      setResult({ ok: false, output: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const onBranchClick = (name: string) => {
    if (mergeMode) {
      setMergeMode(false);
      void act(() => window.dw.gitMerge(cwd, name));
    } else {
      void act(() => window.dw.gitCheckout(cwd, name));
    }
  };

  const submitPrompt = () => {
    const value = draft.trim();
    const kind = prompt;
    setPrompt(null);
    setDraft('');
    if (!value) return;
    if (kind === 'commit') void act(() => window.dw.gitCommit(cwd, value));
    if (kind === 'branch') void act(() => window.dw.gitCreateBranch(cwd, value));
  };

  return (
    <div className="dw-git-menu nodrag" onClick={(e) => e.stopPropagation()}>
      <div className="dw-git-menu-head">
        on <b>{status.branch || 'detached'}</b>
        {status.ahead > 0 && <span className="dw-git-ab">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="dw-git-ab">↓{status.behind}</span>}
        {status.files.length > 0 && (
          <span className="dw-git-dirty">{status.files.length} changed</span>
        )}
      </div>

      {prompt ? (
        <div className="dw-git-prompt">
          <input
            className="dw-ft-prompt-input"
            autoFocus
            placeholder={prompt === 'commit' ? 'Commit message' : 'New branch name'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPrompt();
              if (e.key === 'Escape') setPrompt(null);
            }}
          />
          <div className="dw-ft-prompt-actions">
            <button className="dw-btn-small" onClick={submitPrompt}>
              OK
            </button>
            <button className="dw-btn-small" onClick={() => setPrompt(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="dw-git-branches">
            {mergeMode && <div className="dw-git-hint">Pick a branch to merge in:</div>}
            {branches.map((b) => (
              <button
                key={b.name}
                className={`dw-git-branch ${b.current ? 'current' : ''}`}
                onClick={() => onBranchClick(b.name)}
                disabled={busy || (b.current && !mergeMode)}
              >
                {b.current ? '● ' : '○ '}
                {b.name}
              </button>
            ))}
          </div>

          <div className="dw-git-actions">
            <button className="dw-btn-small" disabled={busy} onClick={() => setPrompt('commit')}>
              Commit
            </button>
            <button className="dw-btn-small" disabled={busy} onClick={() => setPrompt('branch')}>
              New branch
            </button>
            <button
              className={`dw-btn-small ${mergeMode ? 'active' : ''}`}
              disabled={busy}
              onClick={() => setMergeMode((m) => !m)}
            >
              Merge…
            </button>
            <button className="dw-btn-small" disabled={busy} onClick={() => void act(() => window.dw.gitFetch(cwd))}>
              Fetch
            </button>
            <button className="dw-btn-small" disabled={busy} onClick={() => void act(() => window.dw.gitPull(cwd))}>
              Pull
            </button>
            <button className="dw-btn-small" disabled={busy} onClick={() => void act(() => window.dw.gitPush(cwd))}>
              Push
            </button>
            <button className="dw-btn-small" disabled={busy} onClick={() => void act(() => window.dw.gitStash(cwd))}>
              Stash
            </button>
            <button className="dw-btn-small" disabled={busy} onClick={() => void act(() => window.dw.gitStashPop(cwd))}>
              Stash pop
            </button>
          </div>
        </>
      )}

      {result && (
        <div className={`dw-git-result ${result.ok ? 'ok' : 'err'}`}>
          {result.output || (result.ok ? 'Done.' : 'Failed.')}
        </div>
      )}
      {error && <div className="dw-git-result err">{error}</div>}

      <button className="dw-git-menu-close" onClick={onClose} title="Close">
        ×
      </button>
    </div>
  );
}
