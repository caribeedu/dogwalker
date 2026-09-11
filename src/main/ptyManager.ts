import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type {
  DataBatch,
  LiveTerminal,
  PresetId,
  SpawnOptions,
} from '../shared/ipc';
import { defaultShell, presetCommand } from './presets';
import { findOffender, listProcesses } from './processTree';
import type { GraphStore } from './graphStore';

interface Entry {
  proc: pty.IPty;
  mirror: HeadlessTerminal;
  serializer: SerializeAddon;
  name: string;
  /** Ownership, so terminals survive a workspace switch and can be re-adopted. */
  workspaceId: string;
  /** Human floor label ('ground' or a floor name) for `list` context (§10). */
  floorName: string;
  /** Working directory the shell started in (so recruits inherit it, §5.4). */
  cwd: string;
  /** Manager agent flag (PRODUCT.md §5.4). */
  walker: boolean;
  stableId: string;
  preset: PresetId;
  // Attention state (ARCHITECTURE.md §6).
  attention: boolean;
  producedOutput: boolean;
  hasEngaged: boolean;
  quiesce: NodeJS.Timeout | null;
  /** Resolvers waiting for this terminal to next go quiet (used by `ask`). */
  quietWaiters: Array<() => void>;
  /** Runaway guard: MB the child processes may use before the biggest is killed. */
  memoryLimitMB: number;
  /** A preset command is scheduled to auto-run on spawn but hasn't yet. */
  autoexecPending: boolean;
  /** Role file to inject once the preset command's agent has started (spawn ordering). */
  pendingRoleFile: string | null;
  /** node-pty listener handles — disposed in kill() so exit/data cannot race a dead window. */
  dataSub: { dispose(): void };
  exitSub: { dispose(): void };
}

interface PtyEnv {
  socketPath: string;
  shimDir: string;
}

const SCROLLBACK = 2000;
const FLUSH_MS = 16;
/** Delay before auto-executing the preset command, letting the shell init. */
const AUTOEXEC_DELAY_MS = 600;
/** Cap on how long a spawn-time role waits for its agent to boot before injecting anyway. */
const ROLE_AFTER_PRESET_TIMEOUT_MS = 15000;
/** Idle-after-output window that flags a terminal as needing attention. */
const QUIESCENCE_MS = 2500;
/** How often to sample process memory while any terminal has a limit. */
const MEMORY_POLL_MS = 5000;

/**
 * Owns every PTY and its headless mirror (ARCHITECTURE.md §3): the mirror is
 * the main-process source of truth for screen contents, independent of the
 * renderer's xterm instance — `serialize()` works even while the renderer
 * side is suspended (tier 3) or the workspace is hibernated. Also the sole
 * writer to a PTY, so the broker's injected messages and the user's keystrokes
 * share one path.
 */
export class PtyManager {
  private entries = new Map<string, Entry>();
  private nextId = 1;
  private pending = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private memoryTimer: NodeJS.Timeout | null = null;

  constructor(
    private target: WebContents,
    private graph: GraphStore,
    private env: PtyEnv,
    private resolvePreset: (id: PresetId) => string | null = presetCommand,
  ) {}

  /**
   * IPC to the renderer. Quit/`closed` destroys WebContents while PTY exit/data
   * callbacks may still fire — never throw TypeError: Object has been destroyed.
   */
  private safeSend(channel: string, ...args: unknown[]): void {
    if (this.target.isDestroyed()) return;
    try {
      this.target.send(channel, ...args);
    } catch {
      /* window gone between isDestroyed and send */
    }
  }

  spawn(opts: SpawnOptions): { id: string } {
    const id = `t${this.nextId++}`;
    const shell = defaultShell();

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd || os.homedir(),
      env: {
        ...process.env,
        DOGWALKER_TERMINAL_ID: id,
        DOGWALKER_SOCKET: this.env.socketPath,
        // The shim dir goes first so `dogwalker`/`walk` resolve here and only
        // inside canvas terminals (ARCHITECTURE.md §3, §5.1).
        PATH: `${this.env.shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    const mirror = new HeadlessTerminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);

    // Shell-integration marks refine detection when present: command start (C)
    // clears attention, command end (D) raises it immediately.
    mirror.parser.registerOscHandler(133, (payload) => {
      const kind = payload[0];
      if (kind === 'C') this.engage(id);
      else if (kind === 'D') this.setAttention(id, true);
      return true;
    });

    const dataSub = proc.onData((data) => {
      mirror.write(data);
      this.pending.set(id, (this.pending.get(id) ?? '') + data);
      this.scheduleFlush();
      this.onOutput(id);
    });

    const exitSub = proc.onExit(() => {
      // Natural shell exit (not kill()): notify the renderer if it is still alive.
      this.safeSend('pty:exit', id);
      this.graph.removeNode(id);
    });

    this.entries.set(id, {
      proc,
      mirror,
      serializer,
      name: opts.name,
      workspaceId: opts.workspaceId,
      floorName: opts.floorName ?? 'ground',
      cwd: opts.cwd,
      walker: opts.walker ?? false,
      stableId: opts.stableId,
      preset: opts.preset,
      attention: false,
      producedOutput: false,
      hasEngaged: false,
      quiesce: null,
      quietWaiters: [],
      memoryLimitMB: opts.memoryLimitMB ?? 0,
      autoexecPending: false,
      pendingRoleFile: null,
      dataSub,
      exitSub,
    });
    this.syncMemoryPoller();
    this.graph.addNode(id, opts.name, 'terminal', opts.preset);

    const command = this.resolvePreset(opts.preset);
    if (command) {
      const started = this.entries.get(id);
      if (started) started.autoexecPending = true;
      setTimeout(() => {
        const e = this.entries.get(id);
        if (!e) return;
        this.engage(id);
        e.proc.write(command + '\r');
        e.autoexecPending = false;
        // A role assigned during spawn was deferred: the preset command starts
        // the agent first, then — once it has booted and gone quiet — the role
        // is injected, so the agent reads it instead of the bare shell (v1.3.2).
        if (e.pendingRoleFile) {
          const file = e.pendingRoleFile;
          e.pendingRoleFile = null;
          void this.awaitQuiet(id, ROLE_AFTER_PRESET_TIMEOUT_MS).then(() =>
            this.injectRolePrompt(id, file),
          );
        }
      }, AUTOEXEC_DELAY_MS);
    }

    return { id };
  }

  /** Materialize a reusable role beside the project and notify the live agent. */
  assignRole(id: string, role: { id: string; name: string; instructions: string } | null): string {
    const entry = this.entries.get(id);
    if (!entry || !role) return '';
    const dir = path.join(entry.cwd || os.homedir(), '.dogwalker', 'roles');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, entry.stableId + '.md');
    fs.writeFileSync(file, '# ' + role.name + '\n\n' + role.instructions);
    if (entry.autoexecPending) {
      // Spawning with both a preset and a role: defer the injection so the
      // preset command starts the agent first (consumed by spawn once it goes
      // quiet). Injecting now would land the role in the bare shell (v1.3.2).
      entry.pendingRoleFile = file;
    } else {
      this.injectRolePrompt(id, file);
    }
    return file;
  }

  /** Tell a live agent to read its (re)assigned role file. */
  private injectRolePrompt(id: string, file: string): void {
    this.inject(id, 'Your Dogwalker role was updated. Read ' + file + ' before continuing.');
  }

  // ---- attention (ARCHITECTURE.md §6) --------------------------------------
  /** Input ran — reset the attention baseline and mark the terminal engaged. */
  private engage(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.producedOutput = false;
    e.hasEngaged = true;
    if (e.quiesce) {
      clearTimeout(e.quiesce);
      e.quiesce = null;
    }
    this.setAttention(id, false);
  }

  /** Output arrived — the agent is active; flag attention once it goes quiet. */
  private onOutput(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.producedOutput = true;
    if (e.attention) this.setAttention(id, false);
    if (e.quiesce) clearTimeout(e.quiesce);
    e.quiesce = setTimeout(() => {
      if (e.producedOutput && e.hasEngaged) this.setAttention(id, true);
    }, QUIESCENCE_MS);
  }

  private setAttention(id: string, value: boolean): void {
    const e = this.entries.get(id);
    if (!e || e.attention === value) return;
    e.attention = value;
    this.safeSend('pty:attention', { id, value });
    if (value && e.quietWaiters.length) {
      const waiters = e.quietWaiters;
      e.quietWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Resolve when the terminal next goes quiet after output, or on timeout. */
  awaitQuiet(id: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const e = this.entries.get(id);
      if (!e) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      e.quietWaiters.push(finish);
    });
  }

  /** Plain-text snapshot of a terminal's buffer (no ANSI), for `ask` capture. */
  plainText(id: string): string {
    const e = this.entries.get(id);
    if (!e) return '';
    const buf = e.mirror.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\n+$/, '');
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.engage(id); // typing/input clears attention and re-baselines
    entry.proc.write(data);
  }

  /**
   * Deliver a message to a terminal as if pasted by the user. Bracketed-paste
   * open + body + close + CR go in ONE write so the TUI processes the whole
   * paste and the submit in a single pass — no flash, no interleaving with the
   * user (AGENTS.md invariant #3). Paste-wrap only when the target has DEC mode
   * 2004 active; a bare shell gets a plain line.
   */
  inject(id: string, body: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.engage(id);
    const bracketed = entry.mirror.modes.bracketedPasteMode;
    const payload = bracketed ? `\x1b[200~${body}\x1b[201~\r` : `${body}\r`;
    entry.proc.write(payload);
    return true;
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id);
    if (!entry || cols < 2 || rows < 2) return;
    entry.proc.resize(cols, rows);
    entry.mirror.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.quiesce) clearTimeout(entry.quiesce);
    entry.quietWaiters = [];
    // Drop listeners before kill so onExit/onData cannot race a destroyed window
    // (app quit → BrowserWindow closed → killAll → PTY exit).
    entry.dataSub.dispose();
    entry.exitSub.dispose();
    this.entries.delete(id);
    this.pending.delete(id);
    try {
      entry.proc.kill();
    } catch {
      /* already dead */
    }
    entry.mirror.dispose();
    this.graph.removeNode(id);
    this.syncMemoryPoller();
  }

  killAll(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();
    for (const id of [...this.entries.keys()]) this.kill(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Live PTY id for a persistent stableId, if that terminal is running. */
  findByStable(stableId: string): string | null {
    for (const [id, e] of this.entries) {
      if (e.stableId === stableId) return id;
    }
    return null;
  }

  // ---- Walker mode (PRODUCT.md §5.4) --------------------------------------
  isWalker(id: string): boolean {
    return this.entries.get(id)?.walker ?? false;
  }
  setWalker(id: string, walker: boolean): void {
    const e = this.entries.get(id);
    if (e) e.walker = walker;
  }
  cwdOf(id: string): string {
    return this.entries.get(id)?.cwd ?? '';
  }
  workspaceOf(id: string): string {
    return this.entries.get(id)?.workspaceId ?? '';
  }
  nameOf(id: string): string {
    return this.entries.get(id)?.name ?? '';
  }
  presetOf(id: string): PresetId | undefined {
    return this.entries.get(id)?.preset;
  }

  /** Tell the renderer to adopt a recruit near its Walker (§5.4). */
  announceRecruit(e: {
    id: string;
    stableId: string;
    name: string;
    preset: PresetId;
    roleId?: string;
    walkerId: string;
    workspaceId: string;
  }): void {
    this.safeSend('terminal:recruited', e);
  }
  announceDismiss(id: string): void {
    this.safeSend('terminal:dismissed', id);
  }
  announceReassign(id: string, name: string): void {
    this.safeSend('terminal:reassigned', { id, name });
  }

  /** OS pid of a terminal's shell (root of its process tree). */
  pidOf(id: string): number | undefined {
    return this.entries.get(id)?.proc.pid;
  }

  // ---- memory limits (PRODUCT.md §4.1) ------------------------------------
  setMemoryLimit(id: string, mb: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.memoryLimitMB = Math.max(0, mb);
    this.syncMemoryPoller();
  }

  /** The poller exists only while some terminal has a limit — off by default. */
  private syncMemoryPoller(): void {
    const wanted = [...this.entries.values()].some((e) => e.memoryLimitMB > 0);
    if (wanted && !this.memoryTimer) {
      this.memoryTimer = setInterval(() => void this.checkMemory(), MEMORY_POLL_MS);
    } else if (!wanted && this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
  }

  private async checkMemory(): Promise<void> {
    const limited = [...this.entries].filter(([, e]) => e.memoryLimitMB > 0);
    if (limited.length === 0) return;
    const procs = await listProcesses();
    if (procs.length === 0) return;
    for (const [id, e] of limited) {
      const hit = findOffender(procs, e.proc.pid, e.memoryLimitMB);
      if (!hit) continue;
      try {
        process.kill(hit.pid);
      } catch {
        continue; // already gone
      }
      // Say why, in the terminal itself — the shell stays alive.
      const msg =
        `\r\n\x1b[33m[dogwalker] killed pid ${hit.pid}: ` +
        `${hit.totalMB} MB over the ${e.memoryLimitMB} MB limit\x1b[0m\r\n`;
      e.mirror.write(msg);
      this.pending.set(id, (this.pending.get(id) ?? '') + msg);
      this.scheduleFlush();
    }
  }

  /** The floor a terminal lives on (for `list` context); '' if unknown. */
  floorOf(id: string): string {
    return this.entries.get(id)?.floorName ?? '';
  }

  /** Terminals still alive for a workspace, so a returning canvas adopts them. */
  listForWorkspace(workspaceId: string): LiveTerminal[] {
    const out: LiveTerminal[] = [];
    for (const [id, e] of this.entries) {
      if (e.workspaceId === workspaceId) {
        out.push({ id, stableId: e.stableId, name: e.name, preset: e.preset });
      }
    }
    return out;
  }

  /** Release every terminal of a workspace (hibernate). */
  killWorkspace(workspaceId: string): void {
    for (const [id, e] of [...this.entries]) {
      if (e.workspaceId === workspaceId) this.kill(id);
    }
  }

  serialize(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) return '';
    return entry.serializer.serialize({ scrollback: SCROLLBACK });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pending.size === 0) return;
      const batch: DataBatch = [...this.pending.entries()];
      this.pending.clear();
      this.safeSend('pty:data', batch);
    }, FLUSH_MS);
  }
}
