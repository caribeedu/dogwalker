import { useEffect, useState } from 'react';
import type { GitCommit } from '../shared/ipc';
import { computeLanes, type GraphRow } from './gitGraph';

const LANE_W = 14;
const ROW_H = 26;
const DOT_R = 4;
// The theme's own ANSI hues (via CSS vars) so lanes stay distinct and legible
// on any theme's background.
const LANE_COLORS = [
  'var(--dw-lane-1)',
  'var(--dw-lane-2)',
  'var(--dw-lane-3)',
  'var(--dw-lane-4)',
  'var(--dw-lane-5)',
  'var(--dw-lane-6)',
  'var(--dw-lane-7)',
];

function color(i: number): string {
  return LANE_COLORS[i % LANE_COLORS.length];
}

/** Commit history with branch lanes (PRODUCT.md §8), laid out by computeLanes. */
export function GitGraphView({ cwd }: { cwd: string }) {
  const [rows, setRows] = useState<GraphRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.dw
      .gitLog(cwd, 300)
      .then((log: GitCommit[]) => {
        if (!cancelled) setRows(computeLanes(log));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not load history: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  if (error) return <div className="dw-ft-error">{error}</div>;
  if (rows.length === 0) {
    return <div className="dw-ft-empty">No commits.</div>;
  }

  const maxLanes = Math.max(...rows.map((r) => r.laneCount), 1);
  const graphW = maxLanes * LANE_W + LANE_W;

  return (
    <div className="dw-git-graph">
      {rows.map((row) => (
        <div className="dw-git-graph-row" key={row.commit.hash} style={{ height: ROW_H }}>
          <svg width={graphW} height={ROW_H} className="dw-git-graph-svg">
            {row.segments.map((s, si) => {
              const x1 = s.from * LANE_W + LANE_W;
              const x2 = s.to * LANE_W + LANE_W;
              return (
                <path
                  key={si}
                  d={`M ${x1} 0 C ${x1} ${ROW_H / 2}, ${x2} ${ROW_H / 2}, ${x2} ${ROW_H}`}
                  style={{ stroke: color(s.color) }}
                  strokeWidth={1.5}
                  fill="none"
                />
              );
            })}
            <circle
              cx={row.col * LANE_W + LANE_W}
              cy={ROW_H / 2}
              r={DOT_R}
              style={{ fill: color(row.color), stroke: 'var(--dw-bg)' }}
              strokeWidth={1}
            />
          </svg>
          <div className="dw-git-graph-msg">
            {row.commit.refs.map((r) => (
              <span key={r} className="dw-git-ref">
                {r.replace(/^HEAD -> /, '')}
              </span>
            ))}
            <span className="dw-git-subject" title={row.commit.subject}>
              {row.commit.subject}
            </span>
            <span className="dw-git-author">{row.commit.author}</span>
            <span className="dw-git-hash">{row.commit.hash.slice(0, 7)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
