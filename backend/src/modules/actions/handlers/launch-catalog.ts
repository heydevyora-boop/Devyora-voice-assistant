/**
 * The only applications and messaging surfaces this backend will build a
 * hand-off for.
 *
 * This is an allow-list, and it is the whole of the answer to "no
 * unrestricted URLs". A launch descriptor is assembled from a template in
 * this file plus parameters that have already passed an action's input
 * schema. There is no path by which a URL, a scheme, a package name or a
 * shell string from a model, a client or a transcript reaches a device.
 *
 * Nothing here opens anything. The backend cannot launch an application on
 * someone's phone; it returns a descriptor and the device decides. That is
 * why every one of these actions reports HANDOFF and never COMPLETED.
 */

export type Platform = 'ANDROID' | 'IOS' | 'WINDOWS' | 'MACOS' | 'LINUX' | 'WEB';

export interface LaunchTarget {
  /** Custom scheme, where the application registers one. */
  readonly scheme?: string;
  /** Android package, for an intent. */
  readonly androidPackage?: string;
  /** A web address, used only when there is no native target. */
  readonly web?: string;
}

export interface CatalogueEntry {
  readonly id: string;
  readonly label: string;
  /** Words a user might say, matched case-insensitively. */
  readonly aliases: readonly string[];
  readonly targets: Partial<Record<Platform, LaunchTarget>>;
}

/** Applications the assistant can hand off to. */
export const APPLICATIONS: readonly CatalogueEntry[] = [
  {
    id: 'spotify',
    label: 'Spotify',
    aliases: ['spotify'],
    targets: {
      ANDROID: { scheme: 'spotify://', androidPackage: 'com.spotify.music' },
      IOS: { scheme: 'spotify://' },
      WINDOWS: { scheme: 'spotify://' },
      MACOS: { scheme: 'spotify://' },
      WEB: { web: 'https://open.spotify.com' },
    },
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    aliases: ['whatsapp', 'whats app'],
    targets: {
      ANDROID: { scheme: 'whatsapp://', androidPackage: 'com.whatsapp' },
      IOS: { scheme: 'whatsapp://' },
      WEB: { web: 'https://web.whatsapp.com' },
    },
  },
  {
    id: 'youtube',
    label: 'YouTube',
    aliases: ['youtube', 'you tube'],
    targets: {
      ANDROID: { scheme: 'vnd.youtube://', androidPackage: 'com.google.android.youtube' },
      IOS: { scheme: 'youtube://' },
      WEB: { web: 'https://www.youtube.com' },
    },
  },
  {
    id: 'maps',
    label: 'Maps',
    aliases: ['maps', 'google maps'],
    targets: {
      ANDROID: { scheme: 'geo:0,0', androidPackage: 'com.google.android.apps.maps' },
      IOS: { scheme: 'maps://' },
      WEB: { web: 'https://maps.google.com' },
    },
  },
  {
    id: 'calendar',
    label: 'Calendar',
    aliases: ['calendar', 'google calendar'],
    targets: {
      ANDROID: { androidPackage: 'com.google.android.calendar' },
      IOS: { scheme: 'calshow://' },
      MACOS: { scheme: 'ical://' },
      WEB: { web: 'https://calendar.google.com' },
    },
  },
  {
    id: 'settings',
    label: 'Settings',
    aliases: ['settings', 'system settings'],
    targets: {
      ANDROID: { scheme: 'android.settings.SETTINGS' },
      IOS: { scheme: 'App-prefs://' },
    },
  },
];

/**
 * Resolves what the user said to a catalogue entry.
 *
 * Exact and alias matches only. There is deliberately no fuzzy fallback: a
 * near-miss that opened the wrong application would be worse than being
 * told the application is not supported.
 */
export function findApplication(spoken: string): CatalogueEntry | null {
  const needle = spoken.trim().toLowerCase();
  if (!needle) return null;

  return (
    APPLICATIONS.find((app) => app.id === needle || app.aliases.includes(needle)) ?? null
  );
}

export interface MessagingSurface {
  readonly id: string;
  readonly label: string;
  /**
   * Builds a hand-off URL from an address and a message.
   *
   * Takes already-validated values and encodes them. The template is here,
   * in source; only the two parameters vary, and both are escaped.
   */
  readonly compose: (address: string, message: string) => string;
  /** What the address has to look like. Checked before `compose` is called. */
  readonly addressKind: 'phone' | 'email';
}

/**
 * Messaging surfaces the assistant can prepare a draft for.
 *
 * Preparing is all that happens. None of these sends anything: the device
 * opens the draft and the person presses send, which is both the honest
 * capability and the right one for a message in someone's name.
 */
export const MESSAGING_SURFACES: readonly MessagingSurface[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    addressKind: 'phone',
    compose: (address, message) =>
      `https://wa.me/${address.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    addressKind: 'phone',
    compose: (address, message) =>
      `https://t.me/+${address.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`,
  },
  {
    id: 'email',
    label: 'Email',
    addressKind: 'email',
    compose: (address, message) =>
      `mailto:${encodeURIComponent(address)}?body=${encodeURIComponent(message)}`,
  },
];

export function findMessagingSurface(platform: string): MessagingSurface | null {
  const needle = platform.trim().toLowerCase();
  return MESSAGING_SURFACES.find((surface) => surface.id === needle) ?? null;
}

/**
 * Whether an address identifies exactly one destination.
 *
 * The same rule the assistant applies before proposing the action, applied
 * again here. Repeated on purpose: this is the last point before a message
 * is prepared for a real person, and a check that only runs upstream is a
 * check that stops running the moment someone adds another caller.
 */
export function isUsableAddress(address: string, kind: 'phone' | 'email'): boolean {
  const value = address.trim();
  if (!value) return false;

  if (kind === 'phone') {
    const digits = value.replace(/[\s()-]/g, '');
    return /^\+?\d{7,15}$/.test(digits);
  }
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

/** The launch descriptor a device receives. Nothing executable. */
export interface LaunchDescriptor {
  readonly applicationId: string;
  readonly label: string;
  readonly platform: Platform;
  readonly scheme: string | null;
  readonly androidPackage: string | null;
  readonly web: string | null;
}

export function describeLaunch(entry: CatalogueEntry, platform: Platform): LaunchDescriptor | null {
  const target = entry.targets[platform] ?? (entry.targets.WEB ? entry.targets.WEB : null);
  if (!target) return null;

  return {
    applicationId: entry.id,
    label: entry.label,
    platform,
    scheme: target.scheme ?? null,
    androidPackage: target.androidPackage ?? null,
    web: target.web ?? null,
  };
}
