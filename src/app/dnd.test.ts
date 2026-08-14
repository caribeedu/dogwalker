import { describe, it, expect } from 'vitest';
import type { DragEvent } from 'react';
import { DW_FILE_MIME, getFileDrag, setFileDrag } from './dnd';

/** Minimal DataTransfer fake (jsdom does not provide a DataTransfer constructor). */
function makeDataTransfer(entries: Record<string, string> = {}): DataTransfer {
  return {
    types: Object.keys(entries),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    items: [],
    files: [],
    setData: (type: string, value: string) => {
      entries[type] = value;
    },
    getData: (type: string) => entries[type] ?? '',
    clearData: () => {
      for (const key of Object.keys(entries)) delete entries[key];
    },
    setDragImage: () => {},
  } as unknown as DataTransfer;
}

/** Build a fake drag event carrying a DataTransfer fake. */
function dragEvent(init?: (dt: DataTransfer) => void): DragEvent {
  const dt = makeDataTransfer();
  init?.(dt);
  return { dataTransfer: dt } as unknown as DragEvent;
}

describe('dnd', () => {
  it('exports the dogwalker file MIME type constant', () => {
    expect(DW_FILE_MIME).toBe('application/x-dogwalker-file');
  });

  it('setFileDrag puts the path on our MIME type and text/plain', () => {
    const e = dragEvent();
    setFileDrag(e, '/abs/src/main.ts');
    expect(e.dataTransfer.getData(DW_FILE_MIME)).toBe('/abs/src/main.ts');
    expect(e.dataTransfer.getData('text/plain')).toBe('/abs/src/main.ts');
  });

  it('setFileDrag marks the drag as a copy', () => {
    const e = dragEvent();
    setFileDrag(e, '/abs/f.txt');
    expect(e.dataTransfer.effectAllowed).toBe('copy');
  });

  it('getFileDrag reads back the path for one of our drags (round trip)', () => {
    const e = dragEvent();
    setFileDrag(e, '/abs/notes.md');
    expect(getFileDrag(e)).toBe('/abs/notes.md');
  });

  it('getFileDrag returns an empty string for foreign drags', () => {
    const e = dragEvent((dt) => dt.setData('text/plain', 'not ours'));
    expect(getFileDrag(e)).toBe('');
  });

  it('getFileDrag returns an empty string when nothing was set', () => {
    expect(getFileDrag(dragEvent())).toBe('');
  });

  it('setFileDrag with an empty path still sets both types', () => {
    const e = dragEvent();
    setFileDrag(e, '');
    expect(getFileDrag(e)).toBe('');
    expect(e.dataTransfer.getData('text/plain')).toBe('');
    expect(e.dataTransfer.effectAllowed).toBe('copy');
  });
});
