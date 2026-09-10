import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import { PtyManager } from './main/ptyManager';
import { GraphStore } from './main/graphStore';
import { History } from './main/history';
import { Broker } from './main/broker';
import { createShimDir } from './main/shimDir';
import { installSkill } from './main/skillInstall';
import * as fs from 'node:fs';
import * as os from 'node:os';
import crypto from 'node:crypto';
import { WorkspaceStore } from './main/workspaceStore';
import { NoteStore } from './main/noteStore';
import { DraftStore } from './main/draftStore';
import { SettingsStore } from './main/settingsStore';
import { PresetStore } from './main/presetStore';
import { RoleStore } from './main/roleStore';
import { ContractStore } from './main/contractStore';
import { seedFirstRun } from './main/firstRun';
import { FsService } from './main/fsService';
import { GitService } from './main/gitService';
import { PortalManager, type PortalBounds } from './main/portalManager';
import { HookService } from './main/hookService';
import { AgentDocsSync } from './main/agentDocsSync';
import { RoutineService } from './main/routineService';
import { runPortalCli, runPortalLink } from './main/portalIntegration';
import type { AppSettings } from './shared/ipc';
import type {
  FloorRecord,
  ProcessMetric,
  Routine,
  SidebarEntry,
  SpawnOptions,
  WorkspaceLayout,
} from './shared/ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let ptys: PtyManager | null = null;
let broker: Broker | null = null;

/**
 * Deep-copy a layout for "clone ground" when creating a floor, regenerating
 * every node's stableId (and remapping parents/edges) so the clone shares no
 * identity with the ground layer — otherwise notes/portals would collide on a
 * single graph node or note file across layers.
 */
function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const idMap = new Map<string, string>();
  const fresh = (old: string): string => {
    let next = idMap.get(old);
    if (!next) {
      next = 'n' + crypto.randomBytes(6).toString('hex');
      idMap.set(old, next);
    }
    return next;
  };
  const nodes = layout.nodes.map((n) => ({
    ...n,
    stableId: fresh(n.stableId),
    parentStableId: n.parentStableId ? fresh(n.parentStableId) : undefined,
  }));
  const edges = layout.edges.map(
    ([a, b]) => [fresh(a), fresh(b)] as [string, string],
  );
  return { nodes, edges, viewport: layout.viewport };
}

function floorDir(workspaceCwd: string, workspaceId: string, floorName: string): string {
  const safe = floorName.replace(/[^\w.-]/g, '_') || 'floor';
  return path.join(path.dirname(workspaceCwd), '.dogwalker-floors', workspaceId, safe);
}

function brokerPipePath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dogwalker-${process.pid}`;
  }
  return path.join(app.getPath('userData'), `broker-${process.pid}.sock`);
}

/** The app icon PNG — bundled as an extraResource when packaged (see forge.config). */
const appIconPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'assets', 'icons', 'icon.png');

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#101014',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Smoke runs measure fps; Chromium throttles rAF to ~0 in occluded
      // windows, which would corrupt the numbers if the window is covered.
      backgroundThrottling: !process.env.DW_SMOKE,
    },
  });

  const graph = new GraphStore();
  const history = new History(path.join(app.getPath('userData'), 'history'));
  const notes = new NoteStore(app.getPath('userData'), graph);
  const workspaces = new WorkspaceStore(app.getPath('userData'));
  const presets = new PresetStore(app.getPath('userData'));
  const roles = new RoleStore(app.getPath('userData'));
  const contracts = new ContractStore(app.getPath('userData'));
  const shimDir = createShimDir();
  installSkill();
  const socketPath = brokerPipePath();

  ptys = new PtyManager(mainWindow.webContents, graph, { socketPath, shimDir }, (id) =>
    presets.get(id)?.command || null,
  );
  const portals = new PortalManager(mainWindow, mainWindow.webContents);
  broker = new Broker(socketPath, graph, ptys, history, notes, portals, workspaces, presets, roles, contracts);
  broker.listen();

  const wc = mainWindow.webContents;
  graph.on('change', (snap) => {
    if (!wc.isDestroyed()) wc.send('graph:update', snap);
  });
  history.on('append', (pair) => {
    if (!wc.isDestroyed()) wc.send('history:append', pair);
  });
  notes.on('update', (id: string) => {
    if (!wc.isDestroyed()) wc.send('note:update', id);
  });

  ipcMain.handle('graph:get', () => graph.snapshot());
  ipcMain.handle('graph:connect', (_e, { a, b }: { a: string; b: string }) =>
    graph.connect(a, b),
  );
  ipcMain.handle('graph:disconnect', (_e, edgeId: string) =>
    graph.disconnect(edgeId),
  );
  ipcMain.handle('history:between', (_e, { a, b }: { a: string; b: string }) =>
    history.between(a, b),
  );

  ipcMain.handle('note:register', (_e, { id, name }: { id: string; name: string }) =>
    notes.register(id, name),
  );
  ipcMain.handle('note:rename', (_e, { id, name }: { id: string; name: string }) =>
    notes.rename(id, name),
  );
  ipcMain.handle('note:read', (_e, id: string) => notes.read(id));
  ipcMain.handle('note:save', (_e, { id, content }: { id: string; content: string }) =>
    notes.write(id, content),
  );
  ipcMain.handle('note:unload', (_e, id: string) => notes.unload(id));
  ipcMain.handle('note:delete', (_e, id: string) => notes.delete(id));
  ipcMain.handle(
    'note:saveImage',
    (_e, { id, name, bytes }: { id: string; name: string; bytes: Uint8Array }) =>
      notes.saveImage(id, name, bytes),
  );

  // Routines: scheduled prompts to agents (PRODUCT.md §11).
  const routines = new RoutineService(app.getPath('userData'), ptys, (r) => {
    if (!wc.isDestroyed()) wc.send('routine:update', r);
  });
  ipcMain.handle('routine:list', (_e, workspaceId: string) => routines.list(workspaceId));
  ipcMain.handle(
    'routine:create',
    (
      _e,
      {
        workspaceId,
        opts,
      }: {
        workspaceId: string;
        opts: { name: string; targetStableId: string; prompt: string; intervalMs: number };
      },
    ) => routines.create(workspaceId, opts),
  );
  ipcMain.handle(
    'routine:update',
    (_e, { id, partial }: { id: string; partial: Partial<Routine> }) =>
      routines.update(id, partial),
  );
  ipcMain.handle(
    'routine:setEnabled',
    (_e, { id, enabled }: { id: string; enabled: boolean }) =>
      routines.setEnabled(id, enabled),
  );
  ipcMain.handle('routine:runNow', (_e, id: string) => routines.runNow(id));
  ipcMain.handle('routine:delete', (_e, id: string) => routines.remove(id));

  ipcMain.on('notify', (_e, { title, body }: { title: string; body: string }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: appIconPath() });
    // Clicking the toast brings the canvas forward on the terminal that needs it.
    n.on('click', () => {
      if (mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    n.show();
  });

  const settings = new SettingsStore(app.getPath('userData'));
  ipcMain.handle('preset:list', () => presets.list());
  ipcMain.handle('preset:create', (_e, input) => presets.create(input));
  ipcMain.handle('preset:update', (_e, { id, input }) => presets.update(id, input));
  ipcMain.handle('preset:delete', (_e, id: string) => presets.remove(id));
  ipcMain.handle('role:list', () => roles.list());
  ipcMain.handle('role:create', (_e, input) => roles.create(input));
  ipcMain.handle('role:update', (_e, { id, input }) => roles.update(id, input));
  ipcMain.handle('role:delete', (_e, id: string) => roles.remove(id));
  ipcMain.handle('contract:list', () => contracts.list());
  ipcMain.handle('contract:create', (_e, input) => contracts.create(input));
  ipcMain.handle('contract:update', (_e, { id, input }) => contracts.update(id, input));
  ipcMain.handle('contract:delete', (_e, id: string) => contracts.remove(id));
  ipcMain.handle('role:assignTerminal', (_e, { id, roleId }: { id: string; roleId?: string }) =>
    ptys?.assignRole(id, roleId ? roles.get(roleId) : null) ?? '',
  );
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, partial: Partial<AppSettings>) =>
    settings.set(partial),
  );
  ipcMain.handle('themes:listCustom', () => settings.listCustomThemes());

  const drafts = new DraftStore(app.getPath('userData'));
  ipcMain.on(
    'compose:send',
    (_e, { id, text }: { id: string; text: string }) => ptys?.inject(id, text),
  );
  ipcMain.handle('compose:getDraft', (_e, stableId: string) => drafts.get(stableId));
  ipcMain.on(
    'compose:setDraft',
    (_e, { stableId, text }: { stableId: string; text: string }) =>
      drafts.set(stableId, text),
  );
  ipcMain.handle(
    'compose:saveImage',
    (_e, { name, bytes }: { name: string; bytes: Uint8Array }) => {
      const dir = path.join(os.tmpdir(), 'dogwalker-drops');
      fs.mkdirSync(dir, { recursive: true });
      const safe = name.replace(/[^\w.-]/g, '_') || 'image.png';
      const file = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(file, Buffer.from(bytes));
      return file;
    },
  );

  seedFirstRun(workspaces, notes);
  ipcMain.handle('ws:list', () => workspaces.list());
  ipcMain.handle('ws:create', (_e, { name, icon }: { name: string; icon: string }) =>
    workspaces.create(name, icon),
  );
  ipcMain.handle('ws:load', (_e, id: string) => workspaces.load(id));
  ipcMain.handle(
    'ws:saveLayout',
    (_e, { id, layout }: { id: string; layout: WorkspaceLayout }) =>
      workspaces.saveLayout(id, layout),
  );
  ipcMain.handle(
    'ws:loadLayer',
    (_e, { workspaceId, floorId }: { workspaceId: string; floorId: string }) =>
      workspaces.loadLayer(workspaceId, floorId),
  );
  ipcMain.handle(
    'ws:saveLayer',
    (
      _e,
      { workspaceId, floorId, layout }: { workspaceId: string; floorId: string; layout: WorkspaceLayout },
    ) => workspaces.saveLayer(workspaceId, floorId, layout),
  );
  ipcMain.handle(
    'ws:rename',
    (
      _e,
      {
        id,
        name,
        icon,
        cwd,
      }: { id: string; name: string; icon: string; cwd?: string },
    ) => workspaces.rename(id, name, icon, cwd),
  );
  ipcMain.handle('ws:delete', (_e, id: string) => workspaces.remove(id));
  ipcMain.handle('ws:setActive', (_e, id: string) => workspaces.setActive(id));
  const docsSync = new AgentDocsSync();
  for (const w of workspaces.syncEnabled()) docsSync.enable(w.cwd);
  ipcMain.handle(
    'ws:setSyncAgentDocs',
    (_e, { id, enabled }: { id: string; enabled: boolean }) => {
      workspaces.setSyncAgentDocs(id, enabled);
      const cwd = workspaces.load(id).cwd;
      if (enabled) docsSync.enable(cwd);
      else docsSync.disable(cwd);
    },
  );
  ipcMain.handle('ws:listTerminals', (_e, workspaceId: string) =>
    ptys?.listForWorkspace(workspaceId) ?? [],
  );
  ipcMain.handle('ws:hibernate', (_e, workspaceId: string) => {
    ptys?.killWorkspace(workspaceId);
  });
  ipcMain.handle('ws:addDivider', (_e, label: string) =>
    workspaces.addDivider(label),
  );
  ipcMain.handle('ws:renameDivider', (_e, { id, label }: { id: string; label: string }) =>
    workspaces.renameDivider(id, label),
  );
  ipcMain.handle('ws:removeDivider', (_e, id: string) =>
    workspaces.removeDivider(id),
  );
  ipcMain.handle('ws:reorderSidebar', (_e, entries: SidebarEntry[]) =>
    workspaces.reorder(entries),
  );
  ipcMain.handle('sys:pickDirectory', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return res.canceled ? '' : res.filePaths[0];
  });
  ipcMain.handle('sys:openPath', (_e, p: string) => shell.openPath(p).then(() => undefined));

  const fsService = new FsService();
  ipcMain.handle('fs:readDir', (_e, dir: string) => fsService.readDir(dir));
  ipcMain.handle('fs:readFile', (_e, file: string) => fsService.readFile(file));
  ipcMain.handle('fs:readImage', (_e, file: string) => fsService.readImage(file));
  ipcMain.handle('fs:writeFile', (_e, { file, content }: { file: string; content: string }) =>
    fsService.writeFile(file, content),
  );
  ipcMain.handle('fs:create', (_e, { target, isDir }: { target: string; isDir: boolean }) =>
    fsService.create(target, isDir),
  );
  ipcMain.handle('fs:rename', (_e, { from, to }: { from: string; to: string }) =>
    fsService.rename(from, to),
  );
  ipcMain.handle('fs:remove', (_e, target: string) => fsService.remove(target));
  ipcMain.handle('fs:stat', (_e, target: string) => fsService.stat(target));
  ipcMain.handle('fs:searchFiles', (_e, { root, limit }: { root: string; limit: number }) =>
    fsService.searchFiles(root, limit),
  );
  ipcMain.handle(
    'fs:grepFiles',
    (_e, { root, query, limit }: { root: string; query: string; limit: number }) =>
      fsService.grepFiles(root, query, limit),
  );

  const git = new GitService();
  ipcMain.handle('git:status', (_e, cwd: string) => git.status(cwd));
  ipcMain.handle('git:branches', (_e, cwd: string) => git.branches(cwd));
  ipcMain.handle('git:log', (_e, { cwd, limit }: { cwd: string; limit: number }) =>
    git.log(cwd, limit),
  );
  ipcMain.handle('git:diff', (_e, { cwd, file }: { cwd: string; file?: string }) =>
    git.diff(cwd, file),
  );
  ipcMain.handle('git:commit', (_e, { cwd, message }: { cwd: string; message: string }) =>
    git.commit(cwd, message),
  );
  ipcMain.handle('git:checkout', (_e, { cwd, branch }: { cwd: string; branch: string }) =>
    git.checkout(cwd, branch),
  );
  ipcMain.handle('git:createBranch', (_e, { cwd, name }: { cwd: string; name: string }) =>
    git.createBranch(cwd, name),
  );
  ipcMain.handle('git:merge', (_e, { cwd, branch }: { cwd: string; branch: string }) =>
    git.merge(cwd, branch),
  );
  ipcMain.handle('git:stash', (_e, cwd: string) => git.stash(cwd));
  ipcMain.handle('git:stashPop', (_e, cwd: string) => git.stashPop(cwd));
  ipcMain.handle('git:fetch', (_e, cwd: string) => git.fetch(cwd));
  ipcMain.handle('git:pull', (_e, cwd: string) => git.pull(cwd));
  ipcMain.handle('git:push', (_e, cwd: string) => git.push(cwd));

  // Floors: git-worktree layers of a workspace (PRODUCT.md §10).
  const hooks = new HookService();
  const hookCtx = (
    rootPath: string,
    f: { name: string; branch: string; path: string },
  ) => ({ floorName: f.name, branch: f.branch, floorPath: f.path, rootPath });
  ipcMain.handle('floor:list', (_e, workspaceId: string) =>
    workspaces.listFloors(workspaceId),
  );
  ipcMain.handle('floor:repoBranches', async (_e, workspaceId: string) => {
    const ws = workspaces.load(workspaceId);
    return (await git.branches(ws.cwd)).map((b) => b.name);
  });
  ipcMain.handle(
    'floor:create',
    async (
      _e,
      {
        workspaceId,
        opts,
      }: {
        workspaceId: string;
        opts: { name: string; branch: string; createBranch: boolean; cloneGround: boolean };
      },
    ) => {
      const ws = workspaces.load(workspaceId);
      const dir = floorDir(ws.cwd, workspaceId, opts.name);
      if (fs.existsSync(dir)) {
        return { ok: false, error: `a floor path already exists at ${dir}` };
      }
      const res = await git.worktreeAdd(ws.cwd, dir, opts.branch, opts.createBranch);
      if (!res.ok) return { ok: false, error: res.output };
      const record: FloorRecord = {
        id: 'f' + crypto.randomBytes(4).toString('hex'),
        name: opts.name,
        branch: opts.branch,
        path: dir,
        layout: opts.cloneGround ? cloneLayout(ws.layout) : { nodes: [], edges: [] },
      };
      workspaces.addFloor(workspaceId, record);
      // Auto-run the setup hook (deps, .env) in the fresh worktree.
      const setup = await hooks.runHook('setup', hookCtx(ws.cwd, record));
      return {
        ok: true,
        floor: { id: record.id, name: record.name, branch: record.branch, path: record.path },
        setup,
      };
    },
  );
  ipcMain.handle(
    'floor:hookRun',
    async (_e, { workspaceId, floorId }: { workspaceId: string; floorId: string }) => {
      const ws = workspaces.load(workspaceId);
      const floor = workspaces.listFloors(workspaceId).floors.find((f) => f.id === floorId);
      if (!floor) return { ran: false, ok: false, output: 'floor not found' };
      return hooks.runHook('run', hookCtx(ws.cwd, floor));
    },
  );
  ipcMain.handle(
    'floor:remove',
    async (
      _e,
      {
        workspaceId,
        floorId,
        deleteBranch,
      }: { workspaceId: string; floorId: string; deleteBranch: boolean },
    ) => {
      const ws = workspaces.load(workspaceId);
      const floor = workspaces.removeFloorRecord(workspaceId, floorId);
      if (!floor) return { ok: true };
      // Teardown hook, then release the layer's terminals and drop the worktree.
      await hooks.runHook('teardown', hookCtx(ws.cwd, floor));
      ptys?.killWorkspace(floorId);
      const rm = await git.worktreeRemove(ws.cwd, floor.path, true);
      if (deleteBranch) await git.deleteBranch(ws.cwd, floor.branch, true);
      return { ok: rm.ok, error: rm.ok ? undefined : rm.output };
    },
  );
  ipcMain.handle(
    'floor:setActive',
    (_e, { workspaceId, floorId }: { workspaceId: string; floorId: string }) =>
      workspaces.setActiveFloor(workspaceId, floorId),
  );
  // Recovery (v0.7): drop floor records whose worktree vanished, and let git
  // prune its own stale worktree metadata. Safe — it never deletes a worktree
  // that still exists on disk.
  ipcMain.handle('floor:reconcile', async (_e, workspaceId: string) => {
    const ws = workspaces.load(workspaceId);
    for (const f of workspaces.listFloors(workspaceId).floors) {
      if (!fs.existsSync(f.path)) workspaces.removeFloorRecord(workspaceId, f.id);
    }
    await git.worktreePrune(ws.cwd);
    return workspaces.listFloors(workspaceId);
  });
  ipcMain.handle(
    'floor:landInfo',
    async (_e, { workspaceId, floorId }: { workspaceId: string; floorId: string }) => {
      const ws = workspaces.load(workspaceId);
      const floor = workspaces.listFloors(workspaceId).floors.find((f) => f.id === floorId);
      const ground = await git.status(ws.cwd);
      const branches = (await git.branches(ws.cwd)).map((b) => b.name);
      const floorBranch = floor?.branch ?? '';
      const diffStat = floor ? await git.diffStat(ws.cwd, ground.branch, floorBranch) : '';
      const floorClean = floor ? await git.isClean(floor.path) : true;
      return {
        floorBranch,
        groundBranch: ground.branch,
        branches,
        diffStat,
        floorClean,
        groundClean: ground.files.length === 0,
      };
    },
  );
  ipcMain.handle(
    'floor:land',
    async (
      _e,
      {
        workspaceId,
        floorId,
        opts,
      }: {
        workspaceId: string;
        floorId: string;
        opts: { targetBranch: string; deleteBranch: boolean };
      },
    ) => {
      const ws = workspaces.load(workspaceId);
      const cwd = ws.cwd;
      const floor = workspaces.listFloors(workspaceId).floors.find((f) => f.id === floorId);
      if (!floor) return { ok: false, stage: 'gone', error: 'floor not found' };
      // A safe merge needs both trees committed.
      if (!(await git.isClean(floor.path)))
        return { ok: false, stage: 'dirty-floor', error: 'commit or discard the floor changes first' };
      if (!(await git.isClean(cwd)))
        return { ok: false, stage: 'dirty-ground', error: 'the ground has uncommitted changes' };
      // Land onto the chosen branch (check it out in the ground if needed).
      const ground = await git.status(cwd);
      if (ground.branch !== opts.targetBranch) {
        const co = await git.checkout(cwd, opts.targetBranch);
        if (!co.ok) return { ok: false, stage: 'checkout', error: co.output };
      }
      const merge = await git.merge(cwd, floor.branch);
      if (!merge.ok) {
        // Never leave a half-merged tree.
        await git.mergeAbort(cwd);
        return { ok: false, stage: 'conflict', error: merge.output };
      }
      // Merged — tear the floor down (teardown hook first).
      await hooks.runHook('teardown', hookCtx(cwd, floor));
      ptys?.killWorkspace(floorId);
      workspaces.removeFloorRecord(workspaceId, floorId);
      await git.worktreeRemove(cwd, floor.path, true);
      if (opts.deleteBranch) await git.deleteBranch(cwd, floor.branch, true);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'portal:register',
    (_e, { id, name }: { id: string; name: string }) =>
      graph.addNode(id, name, 'portal'),
  );
  ipcMain.handle('portal:unregister', (_e, id: string) => graph.removeNode(id));
  ipcMain.on(
    'portal:create',
    (_e, { id, partition, url }: { id: string; partition: string; url: string }) =>
      portals.create(id, partition, url),
  );
  ipcMain.on(
    'portal:setBounds',
    (
      _e,
      {
        id,
        rect,
        zoom,
        visible,
      }: { id: string; rect: PortalBounds; zoom: number; visible: boolean },
    ) => portals.setBounds(id, rect, zoom, visible),
  );
  ipcMain.on('portal:navigate', (_e, { id, url }: { id: string; url: string }) =>
    portals.navigate(id, url),
  );
  ipcMain.on('portal:back', (_e, id: string) => portals.back(id));
  ipcMain.on('portal:forward', (_e, id: string) => portals.forward(id));
  ipcMain.on('portal:reload', (_e, id: string) => portals.reload(id));
  ipcMain.on('portal:destroy', (_e, id: string) => portals.destroy(id));
  ipcMain.handle('portal:state', (_e, id: string) => portals.state(id));

  // Dev visibility: renderer console mirrored to stdout (no devtools needed).
  wc.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });
  mainWindow.on('closed', () => {
    ptys?.killAll();
    broker?.close();
    portals.destroyAll();
    routines.disposeAll();
    docsSync.disposeAll();
    ptys = null;
    broker = null;
  });

  // Surface renderer load failures instead of a silent black window.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
    dialog.showErrorBox(
      'Dogwalker failed to load',
      `${desc} (${code})\n${url}`,
    );
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const params = [
      process.env.DW_SMOKE ? 'smoke=1' : '',
      process.env.DW_SOAK ? 'soak=1' : '',
      process.env.DW_QUIET ? 'quiet=1' : '',
      process.env.DW_SOAK_MIN ? `soakmin=${process.env.DW_SOAK_MIN}` : '',
      process.env.DW_EDGETEST ? 'edgetest=1' : '',
      process.env.DW_PERSISTTEST ? 'persisttest=1' : '',
      process.env.DW_PALETTETEST ? 'palettetest=1' : '',
      process.env.DW_NOTETEST ? 'notetest=1' : '',
      process.env.DW_COMPOSERTEST ? 'composertest=1' : '',
      process.env.DW_THEMETEST ? 'themetest=1' : '',
      process.env.DW_ATTENTIONTEST ? 'attentiontest=1' : '',
      process.env.DW_LAYOUTTEST ? 'layouttest=1' : '',
      process.env.DW_BGTEST ? 'bgtest=1' : '',
      process.env.DW_SWITCHTEST ? 'switchtest=1' : '',
      process.env.DW_GROUPTEST ? 'grouptest=1' : '',
      process.env.DW_SNAPTEST ? 'snaptest=1' : '',
      process.env.DW_SIDEBARTEST ? 'sidebartest=1' : '',
      process.env.DW_FSNODETEST ? 'fsnodetest=1' : '',
      process.env.DW_FILEOPSTEST ? 'fileopstest=1' : '',
      process.env.DW_EDITORTEST ? 'editortest=1' : '',
      process.env.DW_SEARCHTEST ? 'searchtest=1' : '',
      process.env.DW_IMGTEST ? 'imgtest=1' : '',
      process.env.DW_PORTALTEST ? 'portaltest=1' : '',
    ]
      .filter(Boolean)
      .join('&');
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL + (params ? `?${params}` : ''));
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }




  if (process.env.DW_PORTALCLI) {
    void runPortalCli(ptys, graph, portals, socketPath);
  }

  if (process.env.DW_PORTALLINK) {
    void runPortalLink(ptys, graph, portals, socketPath);
  }
};

ipcMain.handle('pty:spawn', (_e, opts: SpawnOptions) => ptys?.spawn(opts));
ipcMain.on('pty:write', (_e, { id, data }: { id: string; data: string }) =>
  ptys?.write(id, data),
);
ipcMain.on(
  'pty:resize',
  (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
    ptys?.resize(id, cols, rows),
);
ipcMain.on('pty:kill', (_e, id: string) => ptys?.kill(id));
ipcMain.on('pty:memoryLimit', (_e, { id, mb }: { id: string; mb: number }) =>
  ptys?.setMemoryLimit(id, mb),
);
ipcMain.on('pty:setWalker', (_e, { id, walker }: { id: string; walker: boolean }) =>
  ptys?.setWalker(id, walker),
);
ipcMain.handle('mirror:serialize', (_e, id: string) => ptys?.serialize(id) ?? '');
ipcMain.handle('perf:metrics', (): ProcessMetric[] =>
  app.getAppMetrics().map((m) => ({
    type: m.type,
    pid: m.pid,
    cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    memoryMB: Math.round((m.memory.workingSetSize ?? 0) / 1024),
  })),
);

// Windows shows an app's notifications under its AppUserModelID; set a stable
// one so toasts are attributed to Dogwalker (not "electron.app.…").
if (process.platform === 'win32') app.setAppUserModelId('com.dogwalker.app');

// Free in-app auto-updates for packaged Windows/macOS builds, served from this
// repo's GitHub Releases via update.electronjs.org. The library no-ops in dev
// and on Linux; unsigned macOS can't apply updates (Squirrel.Mac needs signing)
// and is skipped with a log line — Windows Squirrel updates unsigned just fine.
if (app.isPackaged) {
  updateElectronApp({
    updateSource: {
      type: UpdateSourceType.ElectronPublicUpdateService,
      repo: 'caribeedu/dogwalker',
    },
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
