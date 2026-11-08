import type { ActionExecutor, ActionOutcome, CommandPlan } from './types';
import { fieldValue } from './types';

const NOTES_KEY = 'devyora.notes';
const REMINDERS_KEY = 'devyora.reminders';

interface StoredNote { id: string; text: string; createdAt: string }
interface StoredReminder { id: string; text: string; at: string | null; createdAt: string }

function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Writes and reads back, so success is confirmed rather than assumed. */
function appendAndVerify<T extends { id: string }>(key: string, item: T): boolean {
  try {
    const list = readList<T>(key);
    list.push(item);
    localStorage.setItem(key, JSON.stringify(list));
    return readList<T>(key).some((entry) => entry.id === item.id);
  } catch {
    return false;
  }
}


/**
 * Open a URL in a new tab and report whether it was actually allowed.
 *
 * `window.open(url, '_blank', 'noopener')` always returns `null` by
 * specification, so using the `noopener` feature would make every successful
 * launch look like a blocked pop-up. The opener reference is severed
 * afterwards instead, which keeps both the security property and a truthful
 * answer about what happened.
 */
function openExternal(url: string): boolean {
  const win = window.open(url, '_blank');
  if (!win) return false;
  try {
    win.opener = null;
  } catch {
    /* cross-origin window: the browser already isolated it */
  }
  return true;
}

/**
 * Executes only what this frontend can genuinely do by itself, and reports
 * the result it actually observed.
 *
 * Anything that leaves the device — a message, a post, a call — is not run
 * here. Those plans are `assisted`: the app prepares them and hands them over,
 * and the outcome says exactly that.
 */
export const localExecutor: ActionExecutor = {
  canRun: (plan) => plan.execution === 'local' || plan.execution === 'assisted',

  run: async (plan: CommandPlan): Promise<ActionOutcome> => {
    switch (plan.kind) {
      case 'note.save': {
        const text = fieldValue(plan, 'text').trim();
        if (!text) return { status: 'failed', detail: 'The note was empty, so nothing was saved.' };
        const ok = appendAndVerify<StoredNote>(NOTES_KEY, {
          id: plan.id,
          text,
          createdAt: new Date().toISOString(),
        });
        return ok
          ? { status: 'completed', detail: 'Saved to notes on this device.' }
          : { status: 'failed', detail: 'This device refused to store the note.' };
      }

      case 'reminder.create': {
        const text = fieldValue(plan, 'text').trim();
        const at = fieldValue(plan, 'when').trim();
        if (!text) return { status: 'failed', detail: 'The reminder had no subject, so nothing was created.' };
        const ok = appendAndVerify<StoredReminder>(REMINDERS_KEY, {
          id: plan.id,
          text,
          at: at || null,
          createdAt: new Date().toISOString(),
        });
        if (!ok) return { status: 'failed', detail: 'This device refused to store the reminder.' };
        return {
          status: 'completed',
          detail: at
            ? `Saved on this device for ${at}. It cannot ring while the app is closed yet.`
            : 'Saved on this device. It cannot ring while the app is closed yet.',
        };
      }

      case 'message.whatsapp': {
        // Deliberately not sent. The app can open a prefilled draft; only the
        // user can press send, so the outcome is a handoff, never a success.
        const recipient = fieldValue(plan, 'recipient');
        const text = fieldValue(plan, 'message');
        const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
        const opened = openExternal(url);
        return opened
          ? {
              status: 'handoff',
              detail: `WhatsApp opened with the draft for ${recipient}. Devyora cannot send it for you — press send there.`,
            }
          : {
              status: 'failed',
              detail: 'The browser blocked the WhatsApp window. Allow pop-ups, or copy the message instead.',
            };
      }

      case 'app.open': {
        const url = fieldValue(plan, 'url');
        if (!url) return { status: 'failed', detail: 'No launch address is known for that application.' };
        const opened = openExternal(url);
        return opened
          ? {
              status: 'handoff',
              detail: `Asked your system to open ${fieldValue(plan, 'app')}. If nothing appeared, it may not be installed.`,
            }
          : { status: 'failed', detail: 'The browser blocked the launch. Allow pop-ups and try again.' };
      }

      case 'assistant.reply':
        return { status: 'completed', detail: 'Answered.' };

      default:
        return { status: 'failed', detail: 'That action has no executor yet.' };
    }
  },
};

/** Read-back helpers for surfaces that list what was stored. */
export const localStore = {
  notes: () => readList<StoredNote>(NOTES_KEY),
  reminders: () => readList<StoredReminder>(REMINDERS_KEY),
};
