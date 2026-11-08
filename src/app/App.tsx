import { Route, Routes, useLocation } from 'react-router-dom';
import { AmbientBackground } from '@/components/shell/AmbientBackground';
import { AppHeader } from '@/components/shell/AppHeader';
import { SecondaryNav } from '@/components/shell/SecondaryNav';
import { ORB_STATE_DEFINITIONS } from '@/features/orb/orbStates';
import { useOrbStore } from '@/stores/orbStore';
import { HomeScreen } from '@/routes/HomeScreen';
import { CompactScreen } from '@/routes/CompactScreen';
import { SettingsScreen } from '@/routes/SettingsScreen';
import { VoiceScreen } from '@/routes/VoiceScreen';
import { PlaceholderScreen } from '@/routes/PlaceholderScreen';
import { StatePreviewScreen } from '@/routes/StatePreviewScreen';

export function App() {
  const state = useOrbStore((s) => s.state);
  const location = useLocation();

  const engaged = state !== 'idle';
  // The compact window is pure orb: no app chrome at all.
  const chromeless = location.pathname === '/compact';

  return (
    <>
      <AmbientBackground />

      {!chromeless ? (
        <AppHeader status={ORB_STATE_DEFINITIONS[state].label} live={engaged} />
      ) : null}

      <main>
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/compact" element={<CompactScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/voice" element={<VoiceScreen />} />
          <Route
            path="/apps"
            element={
              <PlaceholderScreen
                title="Connected apps"
                glyph="apps"
                summary="Link the apps the assistant is allowed to act in, and see what each one can do."
                arrivesIn="Arrives with the secondary surfaces"
              />
            }
          />
          <Route
            path="/style"
            element={
              <PlaceholderScreen
                title="Orb style"
                glyph="tune"
                summary="Shape, palette, size, glow and motion for the orb, applied everywhere it appears."
                arrivesIn="Arrives with the secondary surfaces"
              />
            }
          />
          {import.meta.env.DEV ? (
            <Route path="/dev/states" element={<StatePreviewScreen />} />
          ) : null}
          <Route
            path="*"
            element={
              <PlaceholderScreen
                title="Not found"
                glyph="alert"
                summary="That screen does not exist."
                arrivesIn=""
              />
            }
          />
        </Routes>
      </main>

      {!chromeless ? <SecondaryNav hidden={engaged} /> : null}
    </>
  );
}
