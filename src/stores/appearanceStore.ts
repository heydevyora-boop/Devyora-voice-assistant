import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_APPEARANCE, type OrbAppearance } from '@/features/orb/appearance';

interface AppearanceStore {
  appearance: OrbAppearance;
  /** Replace the saved appearance. Called by the customiser's Save. */
  apply: (appearance: OrbAppearance) => void;
  reset: () => void;
}

/**
 * The saved orb appearance.
 *
 * Persisted with the same Zustand `persist` setup the settings store uses,
 * and read by every `Orb` instance, so a change made in the customiser is the
 * change the main screen and the floating widget show.
 */
export const useAppearanceStore = create<AppearanceStore>()(
  persist(
    (set) => ({
      appearance: DEFAULT_APPEARANCE,
      apply: (appearance) => set({ appearance }),
      reset: () => set({ appearance: DEFAULT_APPEARANCE }),
    }),
    {
      name: 'devyora.orb-appearance',
      version: 1,
      // Browser storage can be absent, full or cleared. The default must
      // always be enough on its own.
      storage: {
        getItem: (name) => {
          try {
            const raw = localStorage.getItem(name);
            return raw ? (JSON.parse(raw) as never) : null;
          } catch {
            return null;
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch {
            /* unavailable — the choice stays for this session only */
          }
        },
        removeItem: (name) => {
          try {
            localStorage.removeItem(name);
          } catch {
            /* nothing to do */
          }
        },
      },
      merge: (persisted, current) => {
        // Guard against a stored shape from an older or corrupted version.
        const saved = (persisted as { appearance?: Partial<OrbAppearance> } | null)?.appearance;
        return { ...current, appearance: { ...DEFAULT_APPEARANCE, ...(saved ?? {}) } };
      },
    },
  ),
);
