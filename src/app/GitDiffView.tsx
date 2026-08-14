import { useEffect, useState } from 'react';
import { parseDiff, type DiffFile } from './diffParse';

/**
 * Side-by-side view of uncommitted changes (PRODUCT.md §8). One `git diff` for
 * the whole repo, parsed into old/new columns per file; files are collapsible.
 */
export function GitDiffView({ cwd, reloadKey }: { cwd: string; reloadKey: number }) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.dw
      .gitDiff(cwd)
      .then((diff) => {
        if (cancelled) return;
        setFiles(parseDiff(diff));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(`Could not load diff: ${String(err)}`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, reloadKey]);

  if (loading) return <div className="dw-ft-empty">Loading diff…</div>;
  if (error) return <div className="dw-ft-error">{error}</div>;
  if (files.length === 0) {
    return <div className="dw-ft-empty">No uncommitted changes.</div>;
  }

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="dw-git-diff">
      {files.map((f) => (
        <div className="dw-git-diff-file" key={f.path}>
          <div className="dw-git-diff-head" onClick={() => toggle(f.path)}>
            <span className="dw-ft-caret">{collapsed.has(f.path) ? '▸' : '▾'}</span>
            <span className="dw-git-diff-path">{f.path}</span>
          </div>
          {!collapsed.has(f.path) && (
            <div className="dw-git-diff-body">
              {f.rows.map((r, i) =>
                r.kind === 'hunk' ? (
                  <div key={i} className="dw-diff-hunk">
                    {r.oldText}
                  </div>
                ) : (
                  <div key={i} className={`dw-diff-row dw-diff-${r.kind}`}>
                    <span className="dw-diff-gutter">{r.oldNo ?? ''}</span>
                    <span className="dw-diff-side dw-diff-old">{r.oldText}</span>
                    <span className="dw-diff-gutter">{r.newNo ?? ''}</span>
                    <span className="dw-diff-side dw-diff-new">{r.newText}</span>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
