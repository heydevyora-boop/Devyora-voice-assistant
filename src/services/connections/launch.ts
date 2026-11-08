import type { Capability } from './types';

/**
 * Open an application's public hand-off URL.
 *
 * Mirrors the executor's launcher: `window.open` with the `noopener` feature
 * always returns `null`, so the opener is severed after the call instead and
 * the caller gets a truthful answer about whether the launch was allowed.
 */
export function launchCapability(capability: Capability): boolean {
  if (!capability.launchUrl) return false;
  const win = window.open(capability.launchUrl, '_blank');
  if (!win) return false;
  try {
    win.opener = null;
  } catch {
    /* cross-origin window: already isolated by the browser */
  }
  return true;
}
