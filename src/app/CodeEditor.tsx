import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { rust } from '@codemirror/lang-rust';

interface Props {
  filePath: string;
  onClose: () => void;
  /** Hand a selection to an agent, with a `path:lineFrom-lineTo` reference. */
  onSend: (text: string, ref: string) => void;
  /** Jump to (and select) this 1-based line on open — used by content search. */
  gotoLine?: number;
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

/** Language support by extension; unknown types get a plain (still highlighted) editor. */
function langFor(path: string): Extension[] {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext))
    return [javascript({ jsx: true, typescript: ext.startsWith('ts') })];
  if (ext === 'json') return [json()];
  if (ext === 'py') return [python()];
  if (['md', 'markdown'].includes(ext)) return [markdown()];
  if (['html', 'htm'].includes(ext)) return [html()];
  if (['css', 'scss', 'less'].includes(ext)) return [css()];
  if (ext === 'rs') return [rust()];
  return [];
}

/**
 * Embedded CodeMirror 6 editor for a File Tree file (PRODUCT.md §8). basicSetup
 * gives syntax highlighting, find & replace (Ctrl+F), and multi-cursor for free;
 * Ctrl+S saves through main; the selection can be handed to a connected agent
 * with a file/line reference. One lightweight instance per open file.
 */
export function CodeEditor({ filePath, onClose, onSend, gotoLine }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasSel, setHasSel] = useState(false);
  const [error, setError] = useState('');

  const save = () => {
    const view = viewRef.current;
    if (!view) return true;
    void window.dw
      .writeFile(filePath, view.state.doc.toString())
      .then(() => {
        setDirty(false);
        setSaved(true);
        setError('');
        window.setTimeout(() => setSaved(false), 1200);
      })
      .catch((err: unknown) => {
        setError(`Could not save: ${String(err)}`);
      });
    return true;
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;
    setError('');
    void window.dw
      .readFile(filePath)
      .then((content) => {
        if (cancelled || !hostRef.current) return;
        const state = EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            ...langFor(filePath),
            oneDark,
            keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => saveRef.current() }]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) setDirty(true);
              if (u.selectionSet || u.docChanged) {
                setHasSel(!u.state.selection.main.empty);
              }
            }),
          ],
        });
        view = new EditorView({ state, parent: hostRef.current });
        viewRef.current = view;
        if (gotoLine && gotoLine >= 1 && gotoLine <= view.state.doc.lines) {
          const line = view.state.doc.line(gotoLine);
          view.dispatch({
            selection: { anchor: line.from, head: line.to },
            scrollIntoView: true,
          });
          view.focus();
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Could not read file: ${String(err)}`);
      });
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [filePath, gotoLine]);

  const sendSelection = () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const text = view.state.sliceDoc(sel.from, sel.to);
    const lineFrom = view.state.doc.lineAt(sel.from).number;
    const lineTo = view.state.doc.lineAt(sel.to).number;
    const ref = `${baseName(filePath)}:${lineFrom}${lineTo !== lineFrom ? `-${lineTo}` : ''}`;
    onSend(text, ref);
  };

  return (
    <div className="dw-editor">
      <div className="dw-editor-bar">
        <button className="dw-ft-btn" title="Back to list" onClick={onClose}>
          ←
        </button>
        <span className="dw-editor-name">
          {baseName(filePath)}
          {dirty && <span className="dw-editor-dot" title="Unsaved changes" />}
        </span>
        {saved && <span className="dw-editor-saved">saved</span>}
        <button
          className="dw-btn-small"
          disabled={!hasSel}
          title="Send the selected text to an agent"
          onClick={sendSelection}
        >
          Send →
        </button>
        <button className="dw-btn-small" onClick={save} title="Save (Ctrl+S)">
          Save
        </button>
      </div>
      {error && <div className="dw-ft-error">{error}</div>}
      <div ref={hostRef} className="dw-editor-host nowheel nodrag" />
    </div>
  );
}
