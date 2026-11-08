import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from '@/app/App';
import { useOrbStore } from '@/stores/orbStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { currentLevels, subscribeLevels } from '@/services/audio/levelBus';
import '@/design/base.css';

/**
 * Development-only handles on the stores, so a test runner can inspect the
 * real state the app reached rather than inferring it from pixels.
 * Stripped from production builds by the `import.meta.env.DEV` guard.
 */
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>;
  w.__orb = useOrbStore;
  w.__voice = useVoiceStore;
  w.__settings = useSettingsStore;
  // The microphone levels deliberately bypass React state, so the suites
  // observe them here rather than on a store.
  w.__levels = { current: currentLevels, subscribe: subscribeLevels };
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
