import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from '@/app/App';
import { useOrbStore } from '@/stores/orbStore';
import '@/design/base.css';

/**
 * Development-only handle on the orb store, so the state machine can be
 * driven end to end from a test runner before the voice pipeline exists.
 * Stripped from production builds by the `import.meta.env.DEV` guard.
 */
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__orb = useOrbStore;
}

/**
 * HashRouter, not BrowserRouter: the same bundle has to run from a web server
 * and from `file://` inside a native shell, where path-based routing has no
 * server to fall back on.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </StrictMode>,
);
