import type { ProviderInfo } from '../types';
import type { CommandPlan } from '../actions/types';
import type { CommandInterpreter, InterpretResult } from './types';

const INFO: ProviderInfo = {
  id: 'rules',
  label: 'On-device phrase rules',
  kind: 'mock',
  note: 'Matches a small set of fixed phrasings on this device. No AI model is connected, so anything outside those patterns is reported as unsupported rather than guessed at.',
};

let counter = 0;
const nextId = () => `plan-${Date.now().toString(36)}-${(counter += 1)}`;

/** Applications this build knows how to launch. */
const KNOWN_APPS: ReadonlyArray<{ match: RegExp; name: string; url: string }> = [
  { match: /\b(whats\s?app)\b/i, name: 'WhatsApp', url: 'https://web.whatsapp.com' },
  { match: /\b(gmail|mail)\b/i, name: 'Gmail', url: 'https://mail.google.com' },
  { match: /\b(calendar)\b/i, name: 'Calendar', url: 'https://calendar.google.com' },
  { match: /\b(maps)\b/i, name: 'Maps', url: 'https://maps.google.com' },
  { match: /\b(youtube)\b/i, name: 'YouTube', url: 'https://youtube.com' },
];

function notePlan(text: string): CommandPlan {
  return {
    id: nextId(),
    kind: 'note.save',
    title: 'Note',
    target: 'Notes on this device',
    targetColor: '#f59e0b',
    glyph: 'rule',
    fields: [{ key: 'text', label: 'Note', value: text, editable: true, multiline: true }],
    execution: 'local',
    // Private, local and reversible, so it does not interrupt the user.
    requiresConfirmation: false,
    spokenReply: 'Saved your note.',
    primaryLabel: 'Save note',
  };
}

function reminderPlan(text: string, when: string): CommandPlan {
  return {
    id: nextId(),
    kind: 'reminder.create',
    title: 'Reminder',
    target: 'Reminders on this device',
    targetColor: '#3b82f6',
    glyph: 'rule',
    fields: [
      { key: 'text', label: 'Remind me to', value: text, editable: true, multiline: true },
      { key: 'when', label: 'When', value: when, editable: true },
    ],
    execution: 'local',
    requiresConfirmation: false,
    spokenReply: 'Reminder saved.',
    primaryLabel: 'Save reminder',
  };
}

function whatsappPlan(recipient: string, message: string): CommandPlan {
  return {
    id: nextId(),
    kind: 'message.whatsapp',
    title: 'WhatsApp message',
    target: 'WhatsApp',
    targetColor: '#25d366',
    glyph: 'send',
    fields: [
      { key: 'recipient', label: 'To', value: recipient, editable: true },
      { key: 'message', label: 'Message', value: message, editable: true, multiline: true },
    ],
    // Leaves the device and is visible to someone else: always confirmed.
    execution: 'assisted',
    requiresConfirmation: true,
    handoffNote:
      'WhatsApp does not let another app send on your behalf. Devyora can open the chat with this text filled in — you press send.',
    primaryLabel: 'Open WhatsApp',
  };
}

function openAppPlan(name: string, url: string): CommandPlan {
  return {
    id: nextId(),
    kind: 'app.open',
    title: 'Open application',
    target: name,
    glyph: 'apps',
    fields: [
      { key: 'app', label: 'Application', value: name, editable: false },
      { key: 'url', label: 'Opens', value: url, editable: false },
    ],
    execution: 'assisted',
    requiresConfirmation: false,
    primaryLabel: `Open ${name}`,
  };
}

/**
 * A deterministic phrase matcher, not a language model.
 *
 * It exists so the interface can be built and exercised before an AI service
 * is connected. It is registered as a `mock` provider and the interface labels
 * it as such, because treating pattern matching as understanding is exactly
 * the kind of claim this product should not make. Anything it does not
 * recognise comes back as `unsupported` — it never guesses.
 */
function parse(raw: string): InterpretResult {
  {
    const text = raw.trim();
    if (!text) {
      return { type: 'unsupported', heard: raw, reason: 'Nothing was recognised.' };
    }

    /* ---- WhatsApp message ---- */
    const whatsapp = text.match(
      /(?:send|write)\s+(?:an?\s+)?(?:whats\s?app|wa)\s*(?:message)?\s+(?:to\s+)?([\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+)?)\s+(?:saying|that says|that|:)\s+(.+)/iu,
    );
    if (whatsapp) {
      const recipient = whatsapp[1].trim();
      const message = whatsapp[2].trim().replace(/[.\s]+$/, '');
      const draft = whatsappPlan(recipient, message);
      // No contact directory is connected, so the recipient cannot be
      // resolved. Ask rather than assume who this is.
      return {
        type: 'clarify',
        clarification: {
          question: `Who is “${recipient}”?`,
          reason: 'No contact list is connected yet, so Devyora cannot look this name up.',
          field: 'recipient',
          draft,
          options: [
            { id: 'as-spoken', label: `Use “${recipient}”`, detail: 'Search for the name in WhatsApp', value: recipient },
            { id: 'number', label: 'Enter a phone number', prompt: 'Phone number with country code' },
          ],
        },
      };
    }

    /* ---- Note ---- */
    const note = text.match(/^(?:save\s+a\s+note|make\s+a\s+note|note\s+(?:this|that|down)|take\s+a\s+note)\s*(?:[:,-]|that|saying)?\s*(.*)$/i);
    if (note) {
      const body = note[1].trim();
      if (!body) {
        return {
          type: 'clarify',
          clarification: {
            question: 'What should the note say?',
            reason: 'The command did not include any text to save.',
            field: 'text',
            draft: notePlan(''),
            options: [{ id: 'dictate', label: 'Type the note', prompt: 'Note text' }],
          },
        };
      }
      return { type: 'plan', plan: notePlan(body) };
    }

    /* ---- Reminder ---- */
    const reminder = text.match(/^(?:remind\s+me\s+to|set\s+a\s+reminder\s+to)\s+(.+?)(?:\s+(?:at|on|in|tomorrow|today)\s+(.+))?$/i);
    if (reminder) {
      const what = reminder[1].trim();
      const whenRaw = reminder[2]?.trim() ?? '';
      const when = whenRaw ? (text.match(/\b(at|on|in|tomorrow|today)\s+/i)?.[1] ?? '') + ' ' + whenRaw : '';
      return { type: 'plan', plan: reminderPlan(what, when.trim()) };
    }

    /* ---- Open an app ---- */
    const open = text.match(/^(?:open|launch|start)\s+(.+)$/i);
    if (open) {
      const wanted = open[1].trim();
      const known = KNOWN_APPS.find((a) => a.match.test(wanted));
      if (known) return { type: 'plan', plan: openAppPlan(known.name, known.url) };
      return {
        type: 'unsupported',
        heard: text,
        reason: `Devyora does not know how to launch “${wanted}” yet. Launching arbitrary applications needs the native shell.`,
      };
    }

    return {
      type: 'unsupported',
      heard: text,
      reason:
        'No AI service is connected, so only a few fixed phrasings are understood. Try “save a note …”, “remind me to …”, “send a WhatsApp message to … saying …”, or “open …”.',
    };
  }
}

export const ruleInterpreter: CommandInterpreter = {
  info: INFO,
  // Matching is synchronous. The contract is a promise so an AI service can
  // replace this without touching a single caller.
  interpret: (raw: string) => Promise.resolve(parse(raw)),
};
