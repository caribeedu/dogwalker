import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import { App } from './app/App';

// Safety net — observability only, never recovery: anything that still escapes
// the local catches lands here as a structured log (mirrored to the main
// process stdout). It does not replace per-call `.catch` handling.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[dw] unhandledrejection:', event.reason);
});

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<App />);
console.log(`dw renderer up · dw api: ${typeof window.dw}`);
