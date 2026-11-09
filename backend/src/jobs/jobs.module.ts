import { Global, Module } from '@nestjs/common';
import { ActionsModule } from '../modules/actions/actions.module';
import { NotesModule } from '../modules/notes/notes.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { RemindersModule } from '../modules/reminders/reminders.module';
import { VoiceModule } from '../modules/voice/voice.module';
import { JobsService } from './jobs.service';
import { QueueService } from './queue.service';

/**
 * Durable background work.
 *
 * `QueueService` is global because producers are spread across the feature
 * modules — a reminder enqueues its own delivery — and a module that
 * imported the whole jobs module to get it would create a cycle with the
 * workers that consume from it.
 *
 * `JobsService` is not exported: nothing should reach into a worker. It
 * consumes.
 */
@Global()
@Module({
  imports: [RemindersModule, NotesModule, NotificationsModule, ActionsModule, VoiceModule],
  providers: [QueueService, JobsService],
  exports: [QueueService],
})
export class JobsModule {}
