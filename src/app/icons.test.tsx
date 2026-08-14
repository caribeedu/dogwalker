import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentType, SVGProps } from 'react';
import {
  ChevronIcon,
  TerminalIcon,
  NoteIcon,
  FilesIcon,
  PortalIcon,
  CrownIcon,
  ImageIcon,
  GearIcon,
  GroundIcon,
  FloorIcon,
  SendIcon,
  SearchIcon,
  PencilIcon,
  TrashIcon,
  WarningIcon,
  CheckIcon,
  CrossIcon,
  DocIcon,
  CodeFileIcon,
  ArchiveIcon,
  WorkspacesIcon,
  RoutinesIcon,
  BoltIcon,
  RoleIcon,
  ContractIcon,
  LinkIcon,
  AlignLeftIcon,
  AlignCenterHIcon,
  AlignRightIcon,
  AlignTopIcon,
  AlignMiddleVIcon,
  AlignBottomIcon,
  DistributeHIcon,
  DistributeVIcon,
  TidyIcon,
  PresetGlyph,
  PRESET_ICON_IDS,
  DEFAULT_PRESET_ICON,
  DogwalkerLogo,
  DogwalkerWordmark,
} from './icons';

type Icon = ComponentType<{ size?: number } & SVGProps<SVGSVGElement>>;

const ALL_GLYPH_ICONS: Array<[string, Icon]> = [
  ['ChevronIcon', ChevronIcon],
  ['TerminalIcon', TerminalIcon],
  ['NoteIcon', NoteIcon],
  ['FilesIcon', FilesIcon],
  ['PortalIcon', PortalIcon],
  ['CrownIcon', CrownIcon],
  ['ImageIcon', ImageIcon],
  ['GearIcon', GearIcon],
  ['GroundIcon', GroundIcon],
  ['FloorIcon', FloorIcon],
  ['SendIcon', SendIcon],
  ['SearchIcon', SearchIcon],
  ['PencilIcon', PencilIcon],
  ['TrashIcon', TrashIcon],
  ['WarningIcon', WarningIcon],
  ['CheckIcon', CheckIcon],
  ['CrossIcon', CrossIcon],
  ['DocIcon', DocIcon],
  ['CodeFileIcon', CodeFileIcon],
  ['ArchiveIcon', ArchiveIcon],
  ['WorkspacesIcon', WorkspacesIcon],
  ['RoutinesIcon', RoutinesIcon],
  ['BoltIcon', BoltIcon],
  ['RoleIcon', RoleIcon],
  ['ContractIcon', ContractIcon],
  ['LinkIcon', LinkIcon],
  ['AlignLeftIcon', AlignLeftIcon],
  ['AlignCenterHIcon', AlignCenterHIcon],
  ['AlignRightIcon', AlignRightIcon],
  ['AlignTopIcon', AlignTopIcon],
  ['AlignMiddleVIcon', AlignMiddleVIcon],
  ['AlignBottomIcon', AlignBottomIcon],
  ['DistributeHIcon', DistributeHIcon],
  ['DistributeVIcon', DistributeVIcon],
  ['TidyIcon', TidyIcon],
];

describe('glyph icons', () => {
  it.each(ALL_GLYPH_ICONS)('renders %s at the default size without crashing', (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(ALL_GLYPH_ICONS)('honors the size prop on %s', (_name, Icon) => {
    const { container } = render(<Icon size={28} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '28');
    expect(container.querySelector('svg')).toHaveAttribute('height', '28');
  });

  it('passes extra SVG props through to the underlying <svg>', () => {
    const { container } = render(<SendIcon className="dw-btn-icon" data-testid="send" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('dw-btn-icon');
    expect(svg).toHaveAttribute('data-testid', 'send');
  });
});

describe('PresetGlyph', () => {
  it('renders a glyph for every registered preset id', () => {
    expect(PRESET_ICON_IDS.length).toBeGreaterThan(0);
    for (const id of PRESET_ICON_IDS) {
      const { container } = render(<PresetGlyph id={id} />);
      expect(container.querySelector('svg')).not.toBeNull();
    }
  });

  it('falls back to the terminal glyph for unknown or missing ids', () => {
    const terminalRect = 'x="2.75" y="4.25" width="18.5" height="15.5" rx="2.75"';
    const unknown = render(<PresetGlyph id="does-not-exist" />);
    expect(unknown.container.querySelector('svg')!.innerHTML).toContain(terminalRect);
    const missing = render(<PresetGlyph />);
    expect(missing.container.querySelector('svg')!.innerHTML).toContain(terminalRect);
  });

  it('exposes the default preset icon id', () => {
    expect(DEFAULT_PRESET_ICON).toBe('sparkle');
    expect(PRESET_ICON_IDS).toContain(DEFAULT_PRESET_ICON);
  });
});

describe('brand marks', () => {
  it('renders DogwalkerLogo with a brand role and label at the default size', () => {
    const { container } = render(<DogwalkerLogo />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Dogwalker');
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('height', '24');
  });

  it('scales DogwalkerLogo with the size prop', () => {
    const { container } = render(<DogwalkerLogo size={48} />);
    expect(container.querySelector('svg')).toHaveAttribute('width', '48');
  });

  it('renders the wordmark lockup with a proportional width and the brand label', () => {
    const { container } = render(<DogwalkerWordmark />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('role', 'img');
    expect(svg).toHaveAttribute('aria-label', 'Dogwalker');
    expect(svg).toHaveAttribute('height', '34');
    expect(svg).toHaveAttribute('width', String(Math.round((34 * 220) / 64)));
    expect(svg).toHaveTextContent('Dogwalker');
  });
});
