import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { parseSkillVersion, installSkillTo, installSkill } from './skillInstall';

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof import('node:os')>('node:os')),
  homedir: homedirMock,
}));

describe('parseSkillVersion', () => {
  it('reads the version from frontmatter', () => {
    expect(parseSkillVersion('---\nname: dogwalker\nversion: 5\n---\n')).toBe(5);
  });

  it('defaults to 0 when there is no version line', () => {
    expect(parseSkillVersion('no frontmatter here')).toBe(0);
  });
});

describe('installSkillTo', () => {
  let dir: string;
  let src: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-skill-'));
    src = path.join(dir, 'SKILL.md');
    fs.writeFileSync(src, '---\nversion: 2\n---\nbody');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('installs fresh (no previous version) and copies the file', () => {
    const dest = path.join(dir, 'dest');
    const res = installSkillTo(src, dest);
    expect(res).toEqual({ version: 2, previousVersion: null, upgraded: false });
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('version: 2');
  });

  it('flags an upgrade when the installed version differs', () => {
    const dest = path.join(dir, 'dest');
    installSkillTo(src, dest);
    fs.writeFileSync(src, '---\nversion: 3\n---\nnewer');
    const res = installSkillTo(src, dest);
    expect(res).toMatchObject({ version: 3, previousVersion: 2, upgraded: true });
  });

  it('does not flag an upgrade when the version is unchanged', () => {
    const dest = path.join(dir, 'dest');
    installSkillTo(src, dest);
    expect(installSkillTo(src, dest).upgraded).toBe(false);
  });
});

describe('installSkill', () => {
  let fakeHome: string;
  let fakeAppPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const writeShippedSkill = (content: string) => {
    const srcDir = path.join(fakeAppPath, 'skills', 'dogwalker');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), content);
  };

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-skill-home-'));
    fakeAppPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-skill-app-'));
    homedirMock.mockReturnValue(fakeHome);
    vi.spyOn(app, 'getAppPath').mockReturnValue(fakeAppPath);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    homedirMock.mockReset();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(fakeAppPath, { recursive: true, force: true });
  });

  it('does nothing when the shipped skill is missing', () => {
    expect(() => installSkill()).not.toThrow();
    expect(fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'dogwalker', 'SKILL.md'))).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('copies the skill into the claude skills folder on a fresh install', () => {
    writeShippedSkill('---\nversion: 2\n---\nbody');
    installSkill();
    const dest = path.join(fakeHome, '.claude', 'skills', 'dogwalker', 'SKILL.md');
    expect(fs.readFileSync(dest, 'utf8')).toContain('version: 2');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs a warning when the installed version differs', () => {
    writeShippedSkill('---\nversion: 3\n---\nbody');
    const destDir = path.join(fakeHome, '.claude', 'skills', 'dogwalker');
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), '---\nversion: 2\n---\nold');
    installSkill();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('v2 → v3');
  });

  it('swallows errors when the destination cannot be written', () => {
    writeShippedSkill('---\nversion: 2\n---\nbody');
    // A plain FILE at ~/.claude makes the nested mkdir fail (ENOTDIR).
    fs.writeFileSync(path.join(fakeHome, '.claude'), 'in the way');
    expect(() => installSkill()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
