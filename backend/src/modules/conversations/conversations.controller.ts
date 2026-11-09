import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { ParseUuidPipe } from '../../common/pipes/parse-uuid.pipe';
import { CurrentUser } from '../../security/decorators/current-user.decorator';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto, RenameConversationDto } from './dto/conversations.dto';

/**
 * Every route is scoped to the authenticated user by the service, so there
 * is no path through this controller that can reach another account.
 */
@ApiTags('conversations')
@Controller({ path: 'conversations', version: '1' })
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiOperation({ summary: 'List conversations, most recently active first.' })
  list(@CurrentUser('userId') userId: string, @Query() query: PaginationQueryDto) {
    return this.conversations.list(userId, query);
  }

  @Post()
  @ApiOperation({ summary: 'Start a conversation.' })
  create(@CurrentUser('userId') userId: string, @Body() dto: CreateConversationDto) {
    return this.conversations.create(userId, dto.title);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one conversation.' })
  get(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.conversations.requireOwned(userId, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Read a conversation’s messages.' })
  messages(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.conversations.messages(userId, id, query);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a conversation.' })
  rename(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
    @Body() dto: RenameConversationDto,
  ) {
    return this.conversations.rename(userId, id, dto.title);
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a conversation without deleting it.' })
  archive(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.conversations.archive(userId, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a conversation.',
    description: 'Removed from view at once; purged permanently after the grace period.',
  })
  remove(
    @CurrentUser('userId') userId: string,
    @Param('id', new ParseUuidPipe('id')) id: string,
  ) {
    return this.conversations.remove(userId, id);
  }

  @Delete()
  @ApiOperation({ summary: 'Delete every conversation for this account.' })
  removeAll(@CurrentUser('userId') userId: string) {
    return this.conversations.removeAll(userId);
  }
}
