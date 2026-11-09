import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { parseVoicePreferences } from '../voice/voice-preferences';
import type { AnyActionDefinition, Permission } from './registry/types';

/** Why an action may not run. One code per distinct cause. */
export type DenialCode =
  | 'account_inactive'
  | 'device_unknown'
  | 'device_revoked'
  | 'assistant_disabled'
  | 'permission_missing'
  | 'integration_not_connected'
  | 'resource_not_owned';

export interface Denial {
  readonly code: DenialCode;
  readonly detail: string;
  /** The permission that was missing, when that is the reason. */
  readonly permission?: Permission;
}

export interface PermissionSubject {
  readonly userId: string;
  readonly deviceId: string;
}

/**
 * Who may do what.
 *
 * Permissions here are **derived from state the server owns** — the account
 * record, the device record, connected accounts, and the user's own
 * preferences — rather than stored as grants. That is a deliberate choice:
 * a grants table with nothing to populate it would be a fiction, and a
 * fiction in an authorization layer is worse than an absence. Each
 * permission below corresponds to a fact that can be checked.
 *
 * What this never consults: model output, request bodies, headers, or any
 * client assertion. The assistant engine's schema has no field in which a
 * model could claim a permission, and this service would not read one if it
 * did.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything this user and device can currently do.
   *
   * Resolved in one pass so a single action check costs one round of
   * queries rather than one per permission.
   */
  async resolve(subject: PermissionSubject): Promise<{
    granted: ReadonlySet<Permission>;
    denial: Denial | null;
  }> {
    const granted = new Set<Permission>();

    const user = await this.prisma.user.findFirst({
      where: { id: subject.userId, deletedAt: null },
      select: { status: true, preference: { select: { voice: true, assistant: true } } },
    });

    if (!user || user.status !== 'ACTIVE') {
      return {
        granted,
        denial: { code: 'account_inactive', detail: 'This account is not active.' },
      };
    }
    granted.add('account.active');

    const device = await this.prisma.device.findFirst({
      where: { id: subject.deviceId, userId: subject.userId },
      select: { revokedAt: true },
    });

    if (!device) {
      // The device is not this user's. Reported as unknown rather than
      // "belongs to someone else", for the same reason a 404 is preferred
      // to a 403 elsewhere.
      return {
        granted,
        denial: { code: 'device_unknown', detail: 'That device is not registered.' },
      };
    }
    if (device.revokedAt) {
      return {
        granted,
        denial: { code: 'device_revoked', detail: 'That device has been signed out.' },
      };
    }
    granted.add('device.active');

    // The user's own switch. A person who has turned the assistant off has
    // withdrawn consent for it to act, and that outranks any request.
    const assistant = parseAssistantPreferences(user.preference?.assistant);
    if (!assistant.actionsEnabled) {
      return {
        granted,
        denial: {
          code: 'assistant_disabled',
          detail: 'Assistant actions are turned off for this account.',
        },
      };
    }
    granted.add('assistant.enabled');

    // Private data this account owns. Always available to its owner.
    granted.add('data.read');
    granted.add('data.write');

    if (assistant.handoffEnabled) granted.add('handoff.launch');
    if (assistant.messagingEnabled) granted.add('messaging.prepare');

    // Reading a third-party account is permitted in principle; whether a
    // specific integration exists is checked per action, below.
    granted.add('integration.read');

    // Parsed so a malformed preference document cannot make voice settings
    // unreadable here either.
    parseVoicePreferences(user.preference?.voice);

    return { granted, denial: null };
  }

  /**
   * Whether this subject may run this action, right now.
   *
   * Called immediately before execution — not only when the action was
   * proposed. The gap between proposing and confirming can be minutes, and
   * a device revoked in that window must not still be able to act.
   */
  async authorise(
    subject: PermissionSubject,
    action: AnyActionDefinition,
  ): Promise<Denial | null> {
    const { granted, denial } = await this.resolve(subject);
    if (denial) return denial;

    for (const permission of action.requiredPermissions) {
      if (!granted.has(permission)) {
        return {
          code: 'permission_missing',
          detail: describeMissing(permission),
          permission,
        };
      }
    }

    if (action.requiresConnection) {
      const connection = await this.prisma.connectedAccount.findFirst({
        where: {
          userId: subject.userId,
          provider: action.requiresConnection as never,
          status: 'CONNECTED',
          revokedAt: null,
        },
        select: { id: true },
      });

      if (!connection) {
        return {
          code: 'integration_not_connected',
          detail:
            `That needs a connected ${action.requiresConnection
              .toLowerCase()
              .replaceAll('_', ' ')} account, and none is linked yet.`,
        };
      }
    }

    return null;
  }
}

/**
 * The assistant half of a user's preferences.
 *
 * Defaults are permissive for private local work and for hand-offs, because
 * that is what the user installed an assistant to do, and the confirmation
 * system — not a preference — is what protects anything externally visible.
 * A user who wants less can turn these off.
 */
export interface AssistantPreferences {
  readonly actionsEnabled: boolean;
  readonly handoffEnabled: boolean;
  readonly messagingEnabled: boolean;
}

const ASSISTANT_DEFAULTS: AssistantPreferences = {
  actionsEnabled: true,
  handoffEnabled: true,
  messagingEnabled: true,
};

export function parseAssistantPreferences(stored: unknown): AssistantPreferences {
  if (!stored || typeof stored !== 'object') return ASSISTANT_DEFAULTS;

  const document = stored as Record<string, unknown>;
  const read = (key: keyof AssistantPreferences): boolean =>
    typeof document[key] === 'boolean' ? document[key] : ASSISTANT_DEFAULTS[key];

  return {
    actionsEnabled: read('actionsEnabled'),
    handoffEnabled: read('handoffEnabled'),
    messagingEnabled: read('messagingEnabled'),
  };
}

function describeMissing(permission: Permission): string {
  switch (permission) {
    case 'handoff.launch':
      return 'Opening applications is turned off for this account.';
    case 'messaging.prepare':
      return 'Preparing messages is turned off for this account.';
    case 'integration.read':
      return 'Reading connected accounts is turned off for this account.';
    case 'data.write':
      return 'Saving data is not permitted for this account.';
    case 'data.read':
      return 'Reading data is not permitted for this account.';
    default:
      return 'This action is not permitted for this account.';
  }
}
