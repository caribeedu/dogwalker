import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TerminalPalette } from './TerminalPalette';

const handlers = () => ({
  onSpawn: vi.fn(),
  onAddNote: vi.fn(),
  onAddFileTree: vi.fn(),
  onAddPortal: vi.fn(),
});

const presets = [
  { id: 'claude', name: 'Claude Code', icon: 'sparkle', command: 'claude', builtin: true },
  { id: 'p1', name: 'My Agent', icon: 'robot', command: 'go' },
];
const roles = [{ id: 'r1', name: 'Reviewer', instructions: 'Review.' }];

describe('TerminalPalette', () => {
  beforeEach(() => {
    // The preset modal reads presets/roles from the preload bridge on mount.
    window.dw = {
      listPresets: vi.fn().mockResolvedValue([]),
      listRoles: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.dw;
  });

  it('offers a button for each node type', () => {
    render(<TerminalPalette {...handlers()} />);
    for (const label of ['Terminal', 'Note', 'Files', 'Portal']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('adds a note directly, without opening the terminal modal', async () => {
    const h = handlers();
    render(<TerminalPalette {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /note/i }));
    expect(h.onAddNote).toHaveBeenCalledOnce();
    expect(h.onSpawn).not.toHaveBeenCalled();
  });

  it('adds a file tree and a portal directly', async () => {
    const h = handlers();
    render(<TerminalPalette {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /files/i }));
    expect(h.onAddFileTree).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: /portal/i }));
    expect(h.onAddPortal).toHaveBeenCalledOnce();
  });

  it('opens the preset picker only when Terminal is clicked', async () => {
    render(<TerminalPalette {...handlers()} />);
    expect(screen.queryByText('New terminal')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
    expect(screen.getByText('New terminal')).toBeInTheDocument();
  });

  it('lists presets and roles, and spawns the default preset without a role', async () => {
    const h = handlers();
    (window.dw.listPresets as ReturnType<typeof vi.fn>).mockResolvedValue(presets);
    (window.dw.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue(roles);
    render(<TerminalPalette {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('My Agent')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Reviewer' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create terminal' }));
    expect(h.onSpawn).toHaveBeenCalledWith('claude', undefined);
    await waitFor(() => expect(screen.queryByText('New terminal')).not.toBeInTheDocument());
  });

  it('spawns with the selected preset and role', async () => {
    const h = handlers();
    (window.dw.listPresets as ReturnType<typeof vi.fn>).mockResolvedValue(presets);
    (window.dw.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue(roles);
    render(<TerminalPalette {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
    await screen.findByText('Claude Code');
    await userEvent.click(screen.getByRole('button', { name: 'My Agent' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'r1');
    await userEvent.click(screen.getByRole('button', { name: 'Create terminal' }));
    expect(h.onSpawn).toHaveBeenCalledWith('p1', 'r1');
  });

  it('disables Create when no presets are registered', async () => {
    render(<TerminalPalette {...handlers()} />);
    await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create terminal' })).toBeDisabled());
  });

  it('closes the modal on Escape, Cancel and scrim click', async () => {
    const h = handlers();
    const { container } = render(<TerminalPalette {...h} />);
    const open = async () => {
      await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
      await waitFor(() => expect(screen.getByText('New terminal')).toBeInTheDocument());
    };
    await open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('New terminal')).not.toBeInTheDocument();
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('New terminal')).not.toBeInTheDocument();
    await open();
    fireEvent.click(container.querySelector('.dw-floor-dialog-scrim')!);
    expect(screen.queryByText('New terminal')).not.toBeInTheDocument();
  });

  it('refreshes the modal when presets or roles change', async () => {
    (window.dw.listPresets as ReturnType<typeof vi.fn>).mockResolvedValue(presets);
    (window.dw.listRoles as ReturnType<typeof vi.fn>).mockResolvedValue(roles);
    render(<TerminalPalette {...handlers()} />);
    await userEvent.click(screen.getByRole('button', { name: /terminal/i }));
    await screen.findByText('Claude Code');
    const presetsCalls = () => (window.dw.listPresets as ReturnType<typeof vi.fn>).mock.calls.length;
    const rolesCalls = () => (window.dw.listRoles as ReturnType<typeof vi.fn>).mock.calls.length;
    window.dispatchEvent(new Event('dw:presets-changed'));
    await waitFor(() => expect(presetsCalls()).toBeGreaterThan(1));
    window.dispatchEvent(new Event('dw:roles-changed'));
    await waitFor(() => expect(rolesCalls()).toBeGreaterThan(1));
  });
});
