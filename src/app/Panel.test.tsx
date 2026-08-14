import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import type { ComponentProps } from 'react';
import type {
  AppSettings,
  WorkspaceMeta,
  Routine,
  LiveTerminal,
  Contract,
} from '../shared/ipc';
import type { TerminalTheme, ThemeSpec } from '../shared/themes';
import { Panel, draftToInput } from './Panel';

// The schema field is a CodeMirror editor; stub it here so the Panel tests stay
// focused on form logic (the schema transform is unit-tested via draftToInput).
vi.mock('./SchemaEditor', () => ({ SchemaEditor: () => null }));

const settings = { themeName: 'a', lightThemeName: 'b', followSystem: false, notifyOnAttention: false } as unknown as AppSettings;

function renderPanel(overrides: Partial<ComponentProps<typeof Panel>> = {}) {
  const props: ComponentProps<typeof Panel> = {
    open: true,
    onClose: vi.fn(),
    workspaces: [],
    activeId: '',
    onSwitch: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onHibernate: vi.fn(),
    themes: [],
    settings,
    activeThemeName: 'a',
    onUpdateSettings: vi.fn(),
    ...overrides,
  };
  render(<Panel {...props} />);
  return props;
}

const goTo = async (section: string) => {
  const props = renderPanel();
  await userEvent.click(screen.getByRole('button', { name: section }));
  return props;
};

const ws = (id: string, name: string, cwd = '/tmp/' + id): WorkspaceMeta => ({
  id,
  name,
  icon: 'sparkle',
  cwd,
});

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  workspaceId: 'ws',
  name: 'Nightly build',
  targetStableId: 's-lead',
  prompt: 'run the tests',
  intervalMs: 300000,
  enabled: true,
  status: 'idle',
  ...overrides,
});

const terminals: LiveTerminal[] = [{ id: 't-lead', stableId: 's-lead', name: 'lead', preset: 'claude' }];

const contract: Contract = {
  id: 'c1',
  name: 'verdict',
  schema: { type: 'object', required: ['decision'] },
  maxAttempts: 3,
  timeoutMs: 180000,
  rejectionPrompt: 'retry',
  fallback: { decision: 'no' },
};

const palette = (): TerminalTheme => ({
  background: '#111',
  foreground: '#eee',
  cursor: '#eee',
  black: '#000',
  red: '#f00',
  green: '#0f0',
  yellow: '#ff0',
  blue: '#00f',
  magenta: '#f0f',
  cyan: '#0ff',
  white: '#fff',
  brightBlack: '#333',
  brightRed: '#f66',
  brightGreen: '#6f6',
  brightYellow: '#ff6',
  brightBlue: '#66f',
  brightMagenta: '#f6f',
  brightCyan: '#6ff',
  brightWhite: '#fff',
});

const theme = (name: string, appearance: 'dark' | 'light'): ThemeSpec => ({
  name,
  appearance,
  builtin: appearance === 'dark',
  theme: palette(),
});

describe('Panel', () => {
  beforeEach(() => {
    window.dw = {
      listPresets: vi.fn().mockResolvedValue([
        { id: 'claude', name: 'Claude Code', icon: 'sparkle', command: 'claude', builtin: true },
        { id: 'p1', name: 'My Agent', icon: 'robot', command: 'go' },
      ]),
      createPreset: vi.fn().mockResolvedValue({ id: 'p2' }),
      updatePreset: vi.fn().mockResolvedValue({}),
      deletePreset: vi.fn().mockResolvedValue(true),
      listRoles: vi.fn().mockResolvedValue([]),
      createRole: vi.fn().mockResolvedValue({ id: 'r1' }),
      updateRole: vi.fn().mockResolvedValue({}),
      deleteRole: vi.fn().mockResolvedValue(true),
      listContracts: vi.fn().mockResolvedValue([]),
      createContract: vi.fn().mockResolvedValue({ id: 'c1' }),
      updateContract: vi.fn().mockResolvedValue({}),
      deleteContract: vi.fn().mockResolvedValue(true),
      listTerminals: vi.fn().mockResolvedValue([]),
      listRoutines: vi.fn().mockResolvedValue([]),
      createRoutine: vi.fn().mockResolvedValue({ id: 'r2' }),
      runRoutineNow: vi.fn().mockResolvedValue(true),
      setRoutineEnabled: vi.fn().mockResolvedValue(true),
      deleteRoutine: vi.fn().mockResolvedValue(true),
      onRoutineUpdate: vi.fn(),
      pickDirectory: vi.fn().mockResolvedValue(null),
      openPath: vi.fn().mockResolvedValue(true),
      setSyncAgentDocs: vi.fn().mockResolvedValue(true),
    } as unknown as typeof window.dw;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('draftToInput', () => {
    const base = { name: 'c', attempts: 3, timeoutSec: 180, rejectionPrompt: '', fallbackText: '' };
    it('rejects a schema that is not a JSON object', () => {
      expect(() => draftToInput({ ...base, schemaText: '[1, 2, 3]' })).toThrow(/JSON object/i);
    });
    it('parses a valid schema and normalizes attempts/timeout', () => {
      const out = draftToInput({ ...base, schemaText: '{"type":"object"}', attempts: 0, timeoutSec: 5 });
      expect(out.schema).toEqual({ type: 'object' });
      expect(out.maxAttempts).toBe(1); // floored to a minimum of 1
      expect(out.timeoutMs).toBe(5000);
    });
    it('parses a JSON fallback and leaves an empty one as null', () => {
      const withFallback = draftToInput({ ...base, schemaText: '{"type":"object"}', fallbackText: '{"x":1}' });
      expect(withFallback.fallback).toEqual({ x: 1 });
      const none = draftToInput({ ...base, schemaText: '{"type":"object"}', fallbackText: '   ' });
      expect(none.fallback).toBeNull();
    });
    it('throws on malformed fallback JSON', () => {
      expect(() => draftToInput({ ...base, schemaText: '{"type":"object"}', fallbackText: '{nope' })).toThrow();
    });
    it('defaults a blank name to "contract"', () => {
      expect(draftToInput({ ...base, schemaText: '{"type":"object"}', name: '   ' }).name).toBe('contract');
    });
  });

  describe('shell', () => {
    it('renders nothing when closed', () => {
      renderPanel({ open: false });
      expect(screen.queryByText('Dogwalker')).not.toBeInTheDocument();
    });

    it('closes on Escape', () => {
      const onClose = vi.fn();
      renderPanel({ onClose });
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the scrim is clicked', () => {
      const onClose = vi.fn();
      const { container } = render(<Panel open onClose={onClose} workspaces={[]} activeId="" onSwitch={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onHibernate={vi.fn()} themes={[]} settings={settings} activeThemeName="a" onUpdateSettings={vi.fn()} />);
      fireEvent.click(container.querySelector('.dw-panel-scrim')!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes via the × button', async () => {
      const onClose = vi.fn();
      renderPanel({ onClose });
      await userEvent.click(screen.getByTitle('Close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Workspaces', () => {
    it('lists workspaces and switches on click', async () => {
      const onSwitch = vi.fn();
      renderPanel({ workspaces: [ws('w1', 'Alpha'), ws('w2', 'Beta')], activeId: 'w2', onSwitch });
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('/tmp/w2')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Alpha/ }));
      expect(onSwitch).toHaveBeenCalledWith('w1');
    });

    it('creates a new workspace', async () => {
      const onCreate = vi.fn();
      renderPanel({ onCreate });
      await userEvent.click(screen.getByRole('button', { name: '+ New' }));
      expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('renames via the editor and saves on Enter', async () => {
      const onRename = vi.fn();
      renderPanel({ workspaces: [ws('w1', 'Alpha')], onRename });
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const nameInput = screen.getByDisplayValue('Alpha');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'Renamed');
      fireEvent.keyDown(nameInput, { key: 'Enter' });
      expect(onRename).toHaveBeenCalledWith('w1', 'Renamed', 'sparkle', '/tmp/w1');
    });

    it('saves edits with the Save button and cancels without renaming', async () => {
      const onRename = vi.fn();
      renderPanel({ workspaces: [ws('w1', 'Alpha')], onRename });
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(onRename).toHaveBeenCalledWith('w1', 'Alpha', 'sparkle', '/tmp/w1');
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onRename).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    });

    it('picks a working directory via the bridge', async () => {
      (window.dw.pickDirectory as ReturnType<typeof vi.fn>).mockResolvedValueOnce('/tmp/chosen');
      renderPanel({ workspaces: [ws('w1', 'Alpha')] });
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await userEvent.click(screen.getByTitle('Choose folder'));
      await waitFor(() => expect(screen.getByDisplayValue('/tmp/chosen')).toBeInTheDocument());
    });

    it('opens the cwd and hibernates the workspace', async () => {
      const onHibernate = vi.fn();
      renderPanel({ workspaces: [ws('w1', 'Alpha')], onHibernate });
      await userEvent.click(screen.getByTitle('Open the working directory'));
      expect(window.dw.openPath).toHaveBeenCalledWith('/tmp/w1');
      await userEvent.click(screen.getByTitle("Release this workspace's terminals"));
      expect(onHibernate).toHaveBeenCalledWith('w1');
    });

    it('deletes a workspace when another remains', async () => {
      const onDelete = vi.fn();
      renderPanel({ workspaces: [ws('w1', 'Alpha'), ws('w2', 'Beta')], onDelete });
      const card = screen.getByText('Alpha').closest('.dw-ws-card') as HTMLElement;
      await userEvent.click(within(card).getByRole('button', { name: 'Delete' }));
      expect(onDelete).toHaveBeenCalledWith('w1');
    });

    it('hides Delete for the last remaining workspace', () => {
      renderPanel({ workspaces: [ws('w1', 'Alpha')] });
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('toggles agent-docs sync', async () => {
      renderPanel({ workspaces: [ws('w1', 'Alpha')] });
      await userEvent.click(screen.getByRole('checkbox', { name: /Sync CLAUDE\.md/ }));
      expect(window.dw.setSyncAgentDocs).toHaveBeenCalledWith('w1', true);
    });
  });

  describe('Routines', () => {
    it('lists routines with resolved targets, intervals and errors', async () => {
      (window.dw.listRoutines as ReturnType<typeof vi.fn>).mockResolvedValue([
        routine(),
        routine({ id: 'r2', name: 'Broken', targetStableId: 's-gone', enabled: false, status: 'paused', lastError: 'peer offline' }),
      ]);
      (window.dw.listTerminals as ReturnType<typeof vi.fn>).mockResolvedValue(terminals);
      await goTo('Routines');
      expect(await screen.findByText('Nightly build')).toBeInTheDocument();
      expect(screen.getByText(/→ lead · every 300s · idle/)).toBeInTheDocument();
      expect(screen.getByText(/\(offline\)/)).toBeInTheDocument();
      expect(screen.getByText(/peer offline/)).toBeInTheDocument();
    });

    it('shows the empty state', async () => {
      (window.dw.listTerminals as ReturnType<typeof vi.fn>).mockResolvedValue(terminals);
      await goTo('Routines');
      expect(await screen.findByText('No routines yet.')).toBeInTheDocument();
    });

    it('creates a routine targeting the live terminal', async () => {
      (window.dw.listTerminals as ReturnType<typeof vi.fn>).mockResolvedValue(terminals);
      await goTo('Routines');
      await userEvent.type(screen.getByPlaceholderText('Name'), 'Daily check');
      await userEvent.type(screen.getByPlaceholderText(/run the tests/), 'run && summarize');
      await waitFor(() => expect(screen.getByRole('button', { name: '+ Add routine' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: '+ Add routine' }));
      expect(window.dw.createRoutine).toHaveBeenCalledWith('', {
        name: 'Daily check',
        targetStableId: 's-lead',
        prompt: 'run && summarize',
        intervalMs: 300000,
      });
    });

    it('disables creation without a live target terminal', async () => {
      await goTo('Routines');
      expect(await screen.findByText('no live terminals')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '+ Add routine' })).toBeDisabled();
    });

    it('runs, pauses and deletes a routine', async () => {
      (window.dw.listRoutines as ReturnType<typeof vi.fn>).mockResolvedValue([routine()]);
      (window.dw.listTerminals as ReturnType<typeof vi.fn>).mockResolvedValue(terminals);
      await goTo('Routines');
      await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
      expect(window.dw.runRoutineNow).toHaveBeenCalledWith('r1');
      await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
      expect(window.dw.setRoutineEnabled).toHaveBeenCalledWith('r1', false);
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(window.dw.deleteRoutine).toHaveBeenCalledWith('r1');
    });

    it('reflects routine updates pushed by the broker', async () => {
      (window.dw.listRoutines as ReturnType<typeof vi.fn>).mockResolvedValue([routine()]);
      (window.dw.listTerminals as ReturnType<typeof vi.fn>).mockResolvedValue(terminals);
      await goTo('Routines');
      await screen.findByText('Nightly build');
      const cb = (window.dw.onRoutineUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      act(() => cb(routine({ status: 'running' })));
      expect(screen.getByText(/· running/)).toBeInTheDocument();
    });
  });

  describe('Settings', () => {
    it('toggles follow-system and attention notifications', async () => {
      const { onUpdateSettings } = await goTo('Settings');
      await userEvent.click(screen.getByRole('checkbox', { name: /Follow system/ }));
      expect(onUpdateSettings).toHaveBeenCalledWith({ followSystem: true });
      await userEvent.click(screen.getByRole('checkbox', { name: /Notify when a terminal needs attention/ }));
      expect(onUpdateSettings).toHaveBeenCalledWith({ notifyOnAttention: true });
    });

    it('switches theme by clicking a theme card', async () => {
      const { onUpdateSettings } = renderPanel({ themes: [theme('Dark', 'dark'), theme('Light', 'light')] });
      await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
      await userEvent.click(screen.getByTitle('Dark'));
      expect(onUpdateSettings).toHaveBeenCalledWith({ themeName: 'Dark' });
      expect(screen.getByText('Active: a')).toBeInTheDocument();
      expect(screen.getByText('custom')).toBeInTheDocument();
    });

    it('shows the light-theme picker only while following the system', async () => {
      const { onUpdateSettings } = renderPanel({
        themes: [theme('Dark', 'dark'), theme('Light', 'light')],
        settings: { ...settings, followSystem: true } as AppSettings,
      });
      await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
      await userEvent.selectOptions(screen.getByRole('combobox'), 'Light');
      expect(onUpdateSettings).toHaveBeenCalledWith({ lightThemeName: 'Light' });
      // The picker is a controlled render: visible only while followSystem is on.
      expect(screen.getByText('Light theme:')).toBeInTheDocument();
    });
  });

  describe('Contracts', () => {
    it('lists contracts with a schema summary', async () => {
      (window.dw.listContracts as ReturnType<typeof vi.fn>).mockResolvedValue([contract]);
      await goTo('Contracts');
      expect(await screen.findByText('verdict')).toBeInTheDocument();
      expect(screen.getByText(/3 attempts · 180s timeout · requires decision/)).toBeInTheDocument();
    });

    it('shows the empty state', async () => {
      await goTo('Contracts');
      expect(await screen.findByText('No contracts yet.')).toBeInTheDocument();
    });

    it('creates a contract from a valid JSON Schema', async () => {
      await goTo('Contracts');
      await userEvent.type(screen.getByPlaceholderText('Contract name'), 'verdict');
      await userEvent.click(screen.getByRole('button', { name: /Add contract/ }));
      await waitFor(() => expect(window.dw.createContract).toHaveBeenCalledTimes(1));
      const arg = (window.dw.createContract as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg).toMatchObject({ name: 'verdict', maxAttempts: 3 });
      expect(typeof arg.schema).toBe('object');
    });

    it('edits, duplicates and deletes a contract', async () => {
      (window.dw.listContracts as ReturnType<typeof vi.fn>).mockResolvedValue([contract]);
      await goTo('Contracts');
      await screen.findByText('verdict');
      // Edit: the form is prefilled from contractToDraft, fallback included.
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const editor = document.querySelector('.dw-preset-editing') as HTMLElement;
      expect((within(editor).getByPlaceholderText('null') as HTMLTextAreaElement).value).toBe(
        JSON.stringify(contract.fallback, null, 2),
      );
      expect((within(editor).getByPlaceholderText(/Please return valid JSON/) as HTMLTextAreaElement).value).toBe('retry');
      const nameInput = screen.getByDisplayValue('verdict');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'verdict2');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(window.dw.updateContract).toHaveBeenCalledWith('c1', expect.objectContaining({ name: 'verdict2' })),
      );
      // Duplicate.
      await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
      expect(window.dw.createContract).toHaveBeenCalledWith(expect.objectContaining({ name: 'verdict copy' }));
      // Delete.
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(window.dw.deleteContract).toHaveBeenCalledWith('c1');
    });
  });

  describe('Presets', () => {
    it('lists the presets and creates a new one', async () => {
      await goTo('Presets');
      expect(await screen.findByText(/My Agent/)).toBeInTheDocument();
      expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
      await userEvent.type(screen.getByPlaceholderText('Name'), 'Aider');
      await userEvent.type(screen.getByPlaceholderText('Command'), 'aider');
      await userEvent.click(screen.getByRole('button', { name: /Add preset/ }));
      expect(window.dw.createPreset).toHaveBeenCalledWith(expect.objectContaining({ name: 'Aider', command: 'aider' }));
    });

    it('edits an existing preset and cancels the edit', async () => {
      await goTo('Presets');
      await screen.findByText('My Agent');
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const nameInput = screen.getByDisplayValue('My Agent');
      await userEvent.clear(nameInput);
      await userEvent.type(nameInput, 'My Agent 2');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(window.dw.updatePreset).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'My Agent 2' })),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(window.dw.updatePreset).toHaveBeenCalledTimes(1);
    });

    it('duplicates and deletes presets', async () => {
      await goTo('Presets');
      await screen.findByText('My Agent');
      const myAgentCard = screen.getByText('My Agent').closest('.dw-routine-card') as HTMLElement;
      await userEvent.click(within(myAgentCard).getByRole('button', { name: 'Duplicate' }));
      expect(window.dw.createPreset).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Agent copy' }));
      await userEvent.click(within(myAgentCard).getByRole('button', { name: 'Delete' }));
      expect(window.dw.deletePreset).toHaveBeenCalledWith('p1');
    });

    it('marks built-in presets and keeps the last preset undeletable', async () => {
      (window.dw.listPresets as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'only', name: 'Only One', icon: 'robot', command: 'x' },
      ]);
      await goTo('Presets');
      await screen.findByText('Only One');
      expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    });

    it('does not create a preset from empty name and command', async () => {
      await goTo('Presets');
      await screen.findByText('My Agent');
      await userEvent.click(screen.getByRole('button', { name: '+ Add preset' }));
      expect(window.dw.createPreset).not.toHaveBeenCalled();
    });

    it('picks an icon from the swatch grid', async () => {
      await goTo('Presets');
      await screen.findByText('My Agent');
      await userEvent.click(screen.getByTitle('robot'));
      await userEvent.type(screen.getByPlaceholderText('Name'), 'Iconed');
      await userEvent.type(screen.getByPlaceholderText('Command'), 'ic');
      await userEvent.click(screen.getByRole('button', { name: '+ Add preset' }));
      expect(window.dw.createPreset).toHaveBeenCalledWith(expect.objectContaining({ name: 'Iconed', icon: 'robot' }));
    });
  });

  describe('Roles', () => {
    it('creates a role from the form', async () => {
      await goTo('Roles');
      await userEvent.type(screen.getByPlaceholderText('Role name'), 'Reviewer');
      await userEvent.type(screen.getByPlaceholderText(/Instructions for this role/), 'Review carefully.');
      await userEvent.click(screen.getByRole('button', { name: /Add role/ }));
      expect(window.dw.createRole).toHaveBeenCalledWith({ name: 'Reviewer', instructions: 'Review carefully.' });
    });

    it('duplicates, edits via prompt and deletes a role', async () => {
      (window.dw.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'r1', name: 'Reviewer', instructions: 'Review.' },
      ]);
      vi.spyOn(window, 'prompt').mockReturnValueOnce('Senior Reviewer').mockReturnValueOnce('Review.');
      await goTo('Roles');
      await screen.findByText('Reviewer');
      await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
      expect(window.dw.createRole).toHaveBeenCalledWith({ name: 'Reviewer copy', instructions: 'Review.' });
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await waitFor(() =>
        expect(window.dw.updateRole).toHaveBeenCalledWith('r1', { name: 'Senior Reviewer', instructions: 'Review.' }),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(window.dw.deleteRole).toHaveBeenCalledWith('r1');
    });
  });
});
