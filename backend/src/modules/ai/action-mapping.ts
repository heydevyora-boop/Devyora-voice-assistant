import type { Command } from './schemas/command.schema';

export interface MappingContext {
  /** The user's timezone, for anything time-bound. */
  readonly timezone: string;
}

/**
 * Turns an interpreted command into an action's parameters.
 *
 * This is the seam between what a model produces and what a handler
 * accepts, and it is deliberately a `switch` with one branch per intent
 * rather than a generic copy of the entities object.
 *
 * The reason is the whole point of the allow-list. A spread would mean any
 * key a model invented arrived at a handler's schema, where at best it is
 * stripped and at worst it collides with a field that means something. Here,
 * each parameter is named in source: a key the model made up has nowhere to
 * go, and a field a handler needs can only come from somewhere this
 * function puts it.
 *
 * Returns null for an intent with no action — a question answered in
 * conversation has no parameters because nothing runs.
 */
export function toActionParams(
  command: Command,
  context: MappingContext,
): Record<string, unknown> | null {
  switch (command.intent) {
    case 'save_note':
      return { text: command.entities.text };

    case 'retrieve_note':
      return { query: command.entities.query, limit: 10 };

    case 'create_reminder':
      return {
        text: command.entities.text,
        dueAt: command.entities.dueAt,
        // The user's own zone, read from their account — not from the model,
        // which has no way to know it and no business asserting it.
        timezone: context.timezone,
      };

    case 'send_message':
    case 'prepare_message':
      return {
        platform: command.entities.platform,
        recipient: command.entities.recipient,
        message: command.entities.message,
      };

    case 'open_application':
      return { application: command.entities.application };

    case 'get_calendar_events':
      return {
        from: command.entities.from,
        to: command.entities.to,
        query: command.entities.query,
      };

    case 'general_question':
      // Answered in conversation. No action, so no parameters.
      return null;
  }
}
