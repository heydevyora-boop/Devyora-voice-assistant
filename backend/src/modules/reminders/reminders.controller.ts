import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { RemindersService } from './reminders.service';
import {
  CreateReminderDto,
  DeleteReminderQueryDto,
  ListRemindersQueryDto,
  SnoozeReminderDto,
  UpcomingQueryDto,
  UpdateReminderDto,
} from './dto/reminders.dto';

@ApiTags('reminders')
@Controller({ path: 'reminders', version: '1' })
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  @ApiOperation({ summary: 'List reminders, filtered and paginated.' })
  list(@CurrentUser('userId') userId: string, @Query() query: ListRemindersQueryDto) {
    return this.reminders.list(userId, query);
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Reminders due between now and a horizon.' })
  upcoming(@CurrentUser('userId') userId: string, @Query() query: UpcomingQueryDto) {
    return this.reminders.upcoming(userId, query.days);
  }

  /**
   * What actually happened.
   *
   * Occurrences rather than reminders, because a weekly reminder is one row
   * and "did Monday's go out?" is a question about one firing. Each entry
   * carries the notification it produced, so the answer chains through to
   * what the transport said rather than stopping at "it was scheduled".
   */
  @Get('history')
  @ApiOperation({ summary: 'Past firings, with what became of each.' })
  history(@CurrentUser('userId') userId: string, @Query() query: PaginationQueryDto) {
    return this.reminders.history(userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one reminder.' })
  get(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.reminders.get(userId, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a reminder.',
    description:
      'The response’s `scheduled` field says whether anything will actually fire. It is ' +
      'false when durable scheduling is unavailable — the reminder is stored, and the ' +
      'user is told it will not alert them.',
  })
  create(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: CreateReminderDto,
  ) {
    return this.reminders.create({ userId, deviceId }, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a reminder, cancelling and re-scheduling its job.' })
  update(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: UpdateReminderDto,
  ) {
    const { expectedVersion, ...changes } = dto;
    return this.reminders.update({ userId, deviceId }, id, changes, expectedVersion);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'Mark a reminder done.',
    description: 'A recurring reminder advances to its next occurrence instead of ending.',
  })
  complete(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.reminders.complete({ userId, deviceId }, id);
  }

  @Post(':id/snooze')
  @ApiOperation({ summary: 'Push a reminder back by a number of minutes from now.' })
  snooze(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: SnoozeReminderDto,
  ) {
    return this.reminders.snooze({ userId, deviceId }, id, dto.minutes);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a reminder.',
    description: 'Soft delete, so the deletion reaches the account’s other devices.',
  })
  remove(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Query() query: DeleteReminderQueryDto,
  ) {
    return this.reminders.remove({ userId, deviceId }, id, query.expectedVersion);
  }
}
