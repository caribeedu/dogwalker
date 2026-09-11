import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PtyManager } from './ptyManager';
import type { Routine } from '../shared/ipc';

/** Max wait for one step's agent turn to finish before moving on. */
const STEP_TIMEOUT_MS = 300_000;

/**
 * Routines (PRODUCT.md §11): a scheduled prompt aimed at an agent, its `&&`-
 * chained steps run one at a time — each waits for the target to go quiet (the
 * same quiescence signal `ask` uses) before the next is injected. A tick that
 * lands while the previous run is still going is skipped, so a slow agent never
 * produces overlapping runs or zombie state. Persisted to routines.json.
 */
export class RoutineService {
  private file: string;
  private routines = new Map<string, Routine>();
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();

  constructor(
    userData: string,
    private ptys: PtyManager,
    private onUpdate: (r: Routine) => void,
  ) {
    this.file = path.join(userData, 'routines.json');
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Routine[];
      for (const r of arr) {
        // Never resurrect a "running" status from a previous session.
        r.status = r.enabled ? 'idle' : 'paused';
        this.routines.set(r.id, r);
      }
    } catch {
      /* no routines yet */
    }
    for (const r of this.routines.values()) if (r.enabled) this.arm(r);
  }

  private persist(): void {
    fs.writeFile(this.file, JSON.stringify([...this.routines.values()], null, 2), () => {});
  }

  /** Split a routine prompt into steps on `&&` (or newlines). */
  static steps(prompt: string): string[] {
    return prompt
      .split(/\n|&&/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  list(workspaceId: string): Routine[] {
    return [...this.routines.values()].filter((r) => r.workspaceId === workspaceId);
  }

  create(
    workspaceId: string,
    opts: { name: string; targetStableId: string; prompt: string; intervalMs: number },
  ): Routine {
    const r: Routine = {
      id: 'r' + crypto.randomBytes(4).toString('hex'),
      workspaceId,
      name: opts.name || 'routine',
      targetStableId: opts.targetStableId,
      prompt: opts.prompt,
      intervalMs: Math.max(5_000, opts.intervalMs),
      enabled: true,
      status: 'idle',
    };
    this.routines.set(r.id, r);
    this.arm(r);
    this.persist();
    return r;
  }

  update(id: string, partial: Partial<Routine>): Routine | null {
    const r = this.routines.get(id);
    if (!r) return null;
    Object.assign(r, partial, { id: r.id, workspaceId: r.workspaceId });
    if (r.intervalMs) r.intervalMs = Math.max(5_000, r.intervalMs);
    // Re-arm so an interval or enabled change takes effect immediately.
    this.disarm(id);
    r.status = r.enabled ? (this.running.has(id) ? 'running' : 'idle') : 'paused';
    if (r.enabled) this.arm(r);
    this.persist();
    this.onUpdate(r);
    return r;
  }

  setEnabled(id: string, enabled: boolean): Routine | null {
    return this.update(id, { enabled });
  }

  remove(id: string): void {
    this.disarm(id);
    this.routines.delete(id);
    this.running.delete(id);
    this.persist();
  }

  private arm(r: Routine): void {
    this.disarm(r.id);
    this.timers.set(
      r.id,
      setInterval(() => {
        void this.tick(r.id).catch((err: unknown) => {
          // Defensive: tick's internal try/finally covers the run itself;
          // this only catches pre-try throws so the scheduler never leaks an
          // unhandled rejection every interval. Observability only.
          console.error(`[dw] routine ${r.id} tick failed:`, err);
        });
      }, r.intervalMs),
    );
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
  }

  /** Run a routine's chain now (also used by the interval + manual trigger). */
  async runNow(id: string): Promise<void> {
    return this.tick(id);
  }

  private async tick(id: string): Promise<void> {
    const r = this.routines.get(id);
    if (!r) return;
    // No overlap: a tick during an in-flight run is dropped.
    if (this.running.has(id)) return;
    const live = this.ptys.findByStable(r.targetStableId);
    if (!live) {
      // Target agent isn't running — skip quietly, try again next interval.
      return;
    }
    this.running.add(id);
    r.status = 'running';
    this.onUpdate(r);
    try {
      for (const step of RoutineService.steps(r.prompt)) {
        this.ptys.inject(live, step);
        await this.ptys.awaitQuiet(live, STEP_TIMEOUT_MS);
      }
      r.lastRun = Date.now();
      r.lastError = undefined;
    } catch (e) {
      r.lastError = (e as Error).message;
    } finally {
      this.running.delete(id);
      r.status = r.enabled ? 'idle' : 'paused';
      this.onUpdate(r);
      this.persist();
    }
  }

  disposeAll(): void {
    for (const id of this.timers.keys()) this.disarm(id);
  }
}
