import { ActionKind, ExecutionMode } from '@prisma/client';
import { z } from 'zod';
import type { ActionDefinition, AnyActionDefinition } from '../registry/types';
import { APPLICATIONS, describeLaunch, findApplication, type Platform } from './launch-catalog';

const launchInput = z.object({
  /**
   * What the user said. Resolved against the catalogue allow-list, never
   * used to build a scheme or a command.
   */
  application: z.string().trim().min(1).max(80),
});

const launchResult = z.object({
  /**
   * A description of what to open. Not a command, not a shell string, and
   * not a URL the caller supplied — assembled from a template in
   * `launch-catalog.ts`.
   */
  launch: z
    .object({
      applicationId: z.string(),
      label: z.string(),
      platform: z.string(),
      scheme: z.string().nullable(),
      androidPackage: z.string().nullable(),
      web: z.string().nullable(),
    })
    .nullable(),
  /** Stated explicitly so no client has to infer it. */
  openedByServer: z.literal(false),
});

/**
 * Hand off to an application.
 *
 * The honest shape of this capability: **the server cannot open an
 * application on someone's device.** It returns a descriptor assembled from
 * an allow-list and the device decides what to do with it. Every outcome is
 * therefore HANDOFF, never COMPLETED, and `openedByServer` is a literal
 * `false` in the result schema so a client cannot read it any other way.
 *
 * No confirmation: opening an application is visible, immediate and
 * harmless, and the user is about to see whether it worked.
 */
const launch: ActionDefinition<z.infer<typeof launchInput>, z.infer<typeof launchResult>> = {
  id: 'apps.launch',
  category: 'apps',
  description: 'Hand off to an application on this device.',
  inputSchema: launchInput,
  requiredParams: ['application'],
  requiredPermissions: ['account.active', 'device.active', 'assistant.enabled', 'handoff.launch'],
  requiresConnection: null,
  confirmationPolicy: 'never',
  idempotency: 'pending-action',
  kind: ActionKind.APP_OPEN,
  executionMode: ExecutionMode.ASSISTED,
  resultSchema: launchResult,

  preview: (input) => [
    { key: 'application', label: 'Application', value: input.application, editable: false },
  ],

  handler: async (input, context) => {
    const entry = findApplication(input.application);
    if (!entry) {
      // Not in the allow-list. Refused rather than guessed at: a near-miss
      // that opened the wrong application would be worse.
      return {
        status: 'FAILED',
        detail: `I cannot open ${input.application}.`,
        verified: true,
        failureCode: 'application_not_supported',
        result: { launch: null, openedByServer: false },
      };
    }

    const device = await context.deps.prisma.device.findFirst({
      where: { id: context.deviceId, userId: context.userId, revokedAt: null },
      select: { platform: true },
    });

    if (!device) {
      return {
        status: 'FAILED',
        detail: 'That device is no longer registered.',
        verified: true,
        failureCode: 'device_unavailable',
        result: { launch: null, openedByServer: false },
      };
    }

    const descriptor = describeLaunch(entry, device.platform as Platform);
    if (!descriptor) {
      return {
        status: 'FAILED',
        detail: `${entry.label} is not available on this platform.`,
        verified: true,
        failureCode: 'platform_not_supported',
        result: { launch: null, openedByServer: false },
      };
    }

    return {
      // HANDOFF, because something verifiable happened — a descriptor was
      // produced — but the task is not finished and must not be reported as
      // success. Whether the application actually opened is something only
      // the device knows.
      status: 'HANDOFF',
      detail: `Ready to open ${entry.label}.`,
      // The descriptor is verified; the launch is not, and cannot be.
      verified: false,
      resultRef: entry.id,
      result: { launch: descriptor, openedByServer: false },
    };
  },
};

export const APP_ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
  launch,
] as unknown as AnyActionDefinition[]);

/** The catalogue, for the capability listing. */
export const LAUNCHABLE_APPLICATIONS = APPLICATIONS.map((a) => ({
  id: a.id,
  label: a.label,
  platforms: Object.keys(a.targets),
}));
