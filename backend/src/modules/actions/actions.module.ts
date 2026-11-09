import { Module } from '@nestjs/common';
import { ActionExecutorService } from './action-executor.service';
import { ActionsController } from './actions.controller';
import { PermissionsService } from './permissions.service';
import { ActionRegistry } from './registry/action.registry';

/**
 * The execution layer.
 *
 * Exported rather than kept private because the assistant engine needs the
 * executor: a turn that proposes an action has to be able to run it. The
 * registry is exported too, so the capability table and the voice layer
 * read the same definitions.
 */
@Module({
  controllers: [ActionsController],
  providers: [ActionRegistry, PermissionsService, ActionExecutorService],
  exports: [ActionRegistry, PermissionsService, ActionExecutorService],
})
export class ActionsModule {}
