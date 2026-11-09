import { Injectable, Logger } from '@nestjs/common';
import { APP_ACTIONS } from '../handlers/apps.actions';
import { CALENDAR_ACTIONS } from '../handlers/calendar.actions';
import { MESSAGING_ACTIONS } from '../handlers/messaging.actions';
import { NOTE_ACTIONS } from '../handlers/notes.actions';
import { REMINDER_ACTIONS } from '../handlers/reminders.actions';
import type { AnyActionDefinition } from './types';

/**
 * The allow-list.
 *
 * Every action this backend can perform is in here, and there is no other
 * way to perform one. Four properties make that true rather than merely
 * intended:
 *
 * **The set is fixed at module load.** `ACTIONS` is a frozen array of
 * frozen module-level constants. There is no `register` function, nothing
 * reads a directory, and nothing adds an entry in response to a request —
 * so what this server can do is decided by what is imported here, and can
 * be audited by reading one file.
 *
 * **Lookup is by exact id against a Map.** No name-to-function resolution,
 * no dynamic `import`, no `eval`, and no property access with a
 * caller-supplied key: a key such as `__proto__` is a missing entry rather
 * than a reachable object property. An unknown id is an error, not a miss
 * that falls through to a default.
 *
 * **The handler is a direct reference.** It is a function written in this
 * repository, reachable only through this map. A model proposes an
 * *intent*; the intent maps to an id in the capability table; the id maps
 * to one of these functions. At no point does text become a call.
 *
 * **Nothing needs constructing to read the policy.** Because the
 * definitions are static, the capability table reads confirmation policy
 * straight from them. There is therefore exactly one place where "does this
 * need confirmation" is written down — and a second copy of that answer is
 * precisely how such a rule gets skipped.
 */
export const ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
  ...NOTE_ACTIONS,
  ...REMINDER_ACTIONS,
  ...APP_ACTIONS,
  ...MESSAGING_ACTIONS,
  ...CALENDAR_ACTIONS,
]);

/** Built once, at module load, so a duplicate id cannot start the process. */
const BY_ID: ReadonlyMap<string, AnyActionDefinition> = (() => {
  const map = new Map<string, AnyActionDefinition>();
  for (const action of ACTIONS) {
    if (map.has(action.id)) {
      // A duplicate id would mean one definition silently shadowing
      // another — including its confirmation policy. Refuse to load.
      throw new Error(`Duplicate action id in the registry: ${action.id}`);
    }
    map.set(action.id, Object.freeze(action));
  }
  return map;
})();

/**
 * The definition for an id, or undefined.
 *
 * Callers must handle undefined rather than assuming. An id that is not
 * here is not an action, whatever produced it.
 */
export function findAction(actionId: string): AnyActionDefinition | undefined {
  return BY_ID.get(actionId);
}

export function hasAction(actionId: string): boolean {
  return BY_ID.has(actionId);
}

/** The definition for an id, or an explicit failure. */
export function requireAction(actionId: string): AnyActionDefinition {
  const action = findAction(actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);
  return action;
}

/** Ids only, for the capability listing and for tests. */
export function actionIds(): readonly string[] {
  return [...BY_ID.keys()].sort();
}

/**
 * The injectable face of the registry.
 *
 * A thin wrapper: the data is static, and this exists so services depend on
 * something Nest can provide and tests can substitute, not because there is
 * state to hold.
 */
@Injectable()
export class ActionRegistry {
  private readonly logger = new Logger(ActionRegistry.name);

  constructor() {
    this.logger.log(
      `Action registry: ${ACTIONS.length} allow-listed actions (${[
        ...new Set(ACTIONS.map((a) => a.category)),
      ]
        .sort()
        .join(', ')}).`,
    );
  }

  find(actionId: string): AnyActionDefinition | undefined {
    return findAction(actionId);
  }

  require(actionId: string): AnyActionDefinition {
    return requireAction(actionId);
  }

  has(actionId: string): boolean {
    return hasAction(actionId);
  }

  list(): readonly AnyActionDefinition[] {
    return ACTIONS;
  }

  ids(): readonly string[] {
    return actionIds();
  }

  /**
   * What a client may be told about the registry.
   *
   * Built explicitly: no schema internals, no handler, nothing that would
   * let a client reason about how an action is implemented.
   */
  describe() {
    return ACTIONS.map((action) => ({
      id: action.id,
      category: action.category,
      description: action.description,
      requiredParams: action.requiredParams,
      requiredPermissions: action.requiredPermissions,
      requiresConnection: action.requiresConnection,
      requiresConfirmation: action.confirmationPolicy === 'always',
      executionMode: action.executionMode,
    }));
  }
}
