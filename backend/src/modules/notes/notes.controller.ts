import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { NotesService } from './notes.service';
import {
  CreateNoteDto,
  DeleteNoteQueryDto,
  ListNotesQueryDto,
  UpdateNoteDto,
} from './dto/notes.dto';

/**
 * Notes.
 *
 * Every route is scoped to the authenticated user by the service, so there
 * is no path through this controller that reaches another account. The
 * device is passed down so a change records which surface made it, which is
 * what lets a syncing client tell its own echo from somebody else's edit.
 */
@ApiTags('notes')
@Controller({ path: 'notes', version: '1' })
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  @ApiOperation({
    summary: 'List notes, with search, filtering, sorting and pagination.',
    description:
      'Pinned first by default. Soft-deleted notes are hidden unless asked for — sync ' +
      'asks for them, because a device needs to know about a deletion.',
  })
  list(@CurrentUser('userId') userId: string, @Query() query: ListNotesQueryDto) {
    return this.notes.list(userId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one note.' })
  get(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.notes.requireOwned(userId, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a note.',
    description: 'Idempotent when a clientId is supplied: a replay updates rather than duplicates.',
  })
  create(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Body() dto: CreateNoteDto,
  ) {
    return this.notes.create({ userId, deviceId }, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a note.',
    description:
      'Send expectedVersion to be told about a conflict instead of overwriting a change ' +
      'made on another device.',
  })
  update(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    const { expectedVersion, ...changes } = dto;
    return this.notes.update({ userId, deviceId }, id, changes, expectedVersion);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a note.',
    description:
      'Soft delete. The note stays, marked, so the deletion can reach the account’s ' +
      'other devices; it is purged permanently after the retention window.',
  })
  remove(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Query() query: DeleteNoteQueryDto,
  ) {
    return this.notes.remove({ userId, deviceId }, id, query.expectedVersion);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a deleted note.' })
  restore(
    @CurrentUser('userId') userId: string,
    @CurrentUser('deviceId') deviceId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.notes.restore({ userId, deviceId }, id);
  }
}
