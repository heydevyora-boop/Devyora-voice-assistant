/**
 * Platform capability detection.
 *
 * The product targets Windows, macOS, Android and iOS with one orb, but the
 * platforms are not equivalent. In particular iOS does not permit an
 * always-on-top overlay above other applications, and no web page on any
 * platform can create a native system overlay by itself.
 *
 * The UI therefore treats "floating overlay" as a capability to be queried,
 * never as an assumption. The native shell (Tauri / Capacitor) overrides these
 * values at startup; the browser build reports what a browser can honestly do.
 */
export type HostKind = 'browser' | 'tauri' | 'capacitor';
export type OsKind = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';

export interface PlatformCapabilities {
  host: HostKind;
  os: OsKind;
  /** True only when a native shell can place a window above other apps. */
  nativeOverlay: boolean;
  /** A compact, chrome-light layout the shell can size a small window to. */
  compactPresentation: boolean;
  globalHotkey: boolean;
  /** Reserved for Chunk 4; no wake-word engine exists in this chunk. */
  wakeWord: 'native' | 'in-app-only' | 'unavailable';
  touchPrimary: boolean;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    Capacitor?: unknown;
  }
}

function detectOs(): OsKind {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  // iPadOS reports as a Mac; the touch point count distinguishes it.
  if (/macintosh/i.test(ua)) return navigator.maxTouchPoints > 1 ? 'ios' : 'macos';
  if (/windows/i.test(ua)) return 'windows';
  if (/linux/i.test(ua)) return 'linux';
  return 'unknown';
}

function detectHost(): HostKind {
  if (typeof window === 'undefined') return 'browser';
  if (window.__TAURI_INTERNALS__ !== undefined) return 'tauri';
  if (window.Capacitor !== undefined) return 'capacitor';
  return 'browser';
}

export function detectCapabilities(): PlatformCapabilities {
  const host = detectHost();
  const os = detectOs();
  const touchPrimary =
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  // A browser tab cannot float above other applications, whatever the OS.
  const nativeOverlay =
    host !== 'browser' && (os === 'windows' || os === 'macos' || os === 'linux' || os === 'android');

  return {
    host,
    os,
    nativeOverlay,
    compactPresentation: true,
    globalHotkey: host === 'tauri' && (os === 'windows' || os === 'macos' || os === 'linux'),
    wakeWord: 'unavailable', // Chunk 4 supplies a provider; nothing claims it yet
    touchPrimary,
  };
}

export const capabilities: PlatformCapabilities = detectCapabilities();
