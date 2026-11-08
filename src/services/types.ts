/**
 * Shared vocabulary for every external-facing service the assistant uses.
 *
 * Each provider must declare whether it is real, a mock, or absent. The UI
 * surfaces that declaration, so a mock can never be mistaken for a working
 * service.
 */
export type ProviderKind = 'real' | 'mock' | 'none';

export interface ProviderInfo {
  /** Stable identifier, e.g. `web-speech`. */
  readonly id: string;
  /** Human-readable name shown in the interface. */
  readonly label: string;
  readonly kind: ProviderKind;
  /** One short sentence explaining what this provider does or why it cannot. */
  readonly note: string;
}

export const NO_PROVIDER = (label: string, note: string): ProviderInfo => ({
  id: 'none',
  label,
  kind: 'none',
  note,
});
