import { Module } from '@nestjs/common';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

/**
 * Reminders.
 *
 * `QueueService` is global, so this module does not import the jobs module
 * — which would be a cycle, since the reminder worker needs this service.
 */
@Module({
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
