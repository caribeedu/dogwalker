import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer, recipientsOf, type ComposerTerminal } from './Composer';

const terminals: ComposerTerminal[] = [
  { id: 't-lead', stableId: 's-lead', name: 'lead' },
  { id: 't-rev', stableId: 's-rev', name: 'reviewer' },
];

function renderComposer() {
  render(<Composer terminals={terminals} focusSignal={0} />);
}

const setText = (value: string) => {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value } });
  return box;
};

describe('recipientsOf', () => {
  it('matches @name with a trailing boundary and not a longer name', () => {
    const t: ComposerTerminal[] = [
      { id: '1', stableId: 's1', name: 'shell' },
      { id: '2', stableId: 's2', name: 'shell-2' },
    ];
    expect(recipientsOf('ping @shell now', t).map((r) => r.id)).toEqual(['1']);
    expect(recipientsOf('ping @shell-2 now', t).map((r) => r.id)).toEqual(['2']);
  });

  it('returns every mentioned terminal', () => {
    expect(recipientsOf('@lead @reviewer sync up', terminals).map((r) => r.id)).toEqual([
      't-lead',
      't-rev',
    ]);
  });

  it('returns none when nothing is mentioned', () => {
    expect(recipientsOf('just thinking out loud', terminals)).toEqual([]);
  });
});

describe('Composer', () => {
  beforeEach(() => {
    window.dw = {
      getDraft: vi.fn().mockResolvedValue(''),
      setDraft: vi.fn(),
      sendPrompt: vi.fn(),
      saveDropImage: vi.fn(),
    } as unknown as typeof window.dw;
  });

  it('opens the mention menu listing live terminals', async () => {
    renderComposer();
    await userEvent.type(screen.getByRole('textbox'), '@');
    expect(screen.getByRole('button', { name: 'lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reviewer' })).toBeInTheDocument();
  });

  it('sends the verbatim text (mentions included) to the mentioned terminal', () => {
    renderComposer();
    setText('@lead ship it');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(window.dw.sendPrompt).toHaveBeenCalledTimes(1);
    expect(window.dw.sendPrompt).toHaveBeenCalledWith('t-lead', '@lead ship it');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('broadcasts to every mentioned terminal', () => {
    renderComposer();
    setText('@lead @reviewer please sync');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(window.dw.sendPrompt).toHaveBeenCalledTimes(2);
    expect(window.dw.sendPrompt).toHaveBeenCalledWith('t-lead', '@lead @reviewer please sync');
    expect(window.dw.sendPrompt).toHaveBeenCalledWith('t-rev', '@lead @reviewer please sync');
  });

  it('does not send when no terminal is mentioned', () => {
    renderComposer();
    setText('nobody home');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(window.dw.sendPrompt).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Mention a terminal first/ })).toBeDisabled();
  });

  it('tints an @mention in the highlight overlay', () => {
    const { container } = render(<Composer terminals={terminals} focusSignal={0} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@lead ok' } });
    const hl = container.querySelector('.dw-mention-hl');
    expect(hl?.textContent).toBe('@lead');
  });

  it('does not submit on Shift+Enter', () => {
    renderComposer();
    const box = setText('@lead line one');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(window.dw.sendPrompt).not.toHaveBeenCalled();
  });

  it('does not resurrect the just-sent text as a draft (pending debounce is cancelled)', () => {
    vi.useFakeTimers();
    try {
      renderComposer();
      setText('@lead hello');
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
      vi.advanceTimersByTime(1000);
      const calls = (window.dw.setDraft as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.at(-1)).toEqual(['__composer__', '']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('focuses the textarea when focusSignal increments', () => {
    render(<Composer terminals={terminals} focusSignal={1} />);
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('renders nothing when there are no live terminals', () => {
    render(<Composer terminals={[]} focusSignal={0} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('persists the draft after the debounce elapses', () => {
    vi.useFakeTimers();
    try {
      renderComposer();
      setText('hello draft');
      vi.advanceTimersByTime(400);
      expect(window.dw.setDraft).toHaveBeenCalledWith('__composer__', 'hello draft');
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts a mention from the menu by clicking it', async () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '@');
    await userEvent.click(screen.getByRole('button', { name: 'lead' }));
    expect((box as HTMLTextAreaElement).value).toBe('@lead ');
    expect(screen.queryByRole('button', { name: 'reviewer' })).not.toBeInTheDocument();
  });

  it('navigates the mention menu with arrows and inserts with Tab', async () => {
    const { container } = render(<Composer terminals={terminals} focusSignal={0} />);
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '@');
    const items = () => container.querySelectorAll('.dw-mention-item');
    expect(items().length).toBe(2);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(items()[1]).toHaveClass('active');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(items()[0]).toHaveClass('active');
    fireEvent.keyDown(box, { key: 'Tab' });
    expect((box as HTMLTextAreaElement).value).toBe('@lead ');
  });

  it('inserts the first mention with Enter, then sends with a second Enter', async () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '@');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((box as HTMLTextAreaElement).value).toBe('@lead ');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(window.dw.sendPrompt).toHaveBeenCalledWith('t-lead', '@lead');
  });

  it('closes the mention menu with Escape', async () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '@');
    expect(screen.getByRole('button', { name: 'lead' })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'lead' })).not.toBeInTheDocument();
  });

  it('filters mentions by the partial token after @', async () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '@rev');
    expect(screen.queryByRole('button', { name: 'lead' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reviewer' })).toBeInTheDocument();
  });

  it('marks walker terminals with the crown glyph in the mention menu', async () => {
    const withWalker: ComposerTerminal[] = [
      { id: 't-w', stableId: 's-w', name: 'walker', walker: true },
      { id: 't-n', stableId: 's-n', name: 'plain' },
    ];
    render(<Composer terminals={withWalker} focusSignal={0} />);
    await userEvent.type(screen.getByRole('textbox'), '@');
    const items = document.querySelectorAll('.dw-mention-item');
    expect(items[0].innerHTML).toContain('M4 8l4 3.5'); // crown glyph
    expect(items[1].innerHTML).toContain('x="2.75"'); // terminal glyph
  });

  it('sends via the send button once a terminal is mentioned', () => {
    renderComposer();
    setText('@lead go');
    // Sync click: an awaited click would let the async draft-load overwrite the
    // text before the click lands (see the sync pattern in the Enter tests).
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    expect(window.dw.sendPrompt).toHaveBeenCalledWith('t-lead', '@lead go');
  });

  it('inserts a pasted image path into the draft', async () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    const file = new File(['bytes'], 'clip.png', { type: 'image/png' });
    (window.dw.saveDropImage as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/clip.png');
    fireEvent.paste(box, {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => file }] },
    });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('/tmp/clip.png '));
  });

  it('ignores non-image paste content', async () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    fireEvent.paste(box, {
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] },
    });
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(window.dw.saveDropImage).not.toHaveBeenCalled();
  });

  it('syncs the highlight overlay scroll with the textarea', () => {
    renderComposer();
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'hello @lead world' } });
    const hl = document.querySelector('.dw-composer-highlight') as HTMLElement;
    fireEvent.scroll(box);
    expect(hl.scrollTop).toBe(0);
  });
});
