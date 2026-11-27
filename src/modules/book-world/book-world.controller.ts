import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { BookWorldService } from './book-world.service';
import { MarkWorldReadDto } from './dto/mark-world-read.dto';
import { SetWorldFlagsDto } from './dto/set-world-flags.dto';
import {
  BookWorldEntityResponseDto,
  BookWorldEntitySaveResponseDto,
  BookWorldEntitySummaryDto,
  BookWorldListResponseDto,
  BookWorldSaveResponseDto,
} from './dto/book-world-response.dto';
import { ListBookWorldQueryDto } from './dto/list-book-world-query.dto';
import {
  SaveBookWorldQueryDto,
  SaveBookWorldVersionQueryDto,
} from './dto/save-book-world-query.dto';
import { UpdateBookWorldDto, UpdateBookWorldEntityDto } from './dto/update-book-world.dto';

type ActorRequest = { user?: { userId: string; email: string } };

/**
 * Мир книги версии (F08-1, `books-app-docs/features/F08-book-wiki/tech.md` §3). Без
 * `PublicCacheInterceptor`: ответ `GET` зависит от роли (редактору — все сущности и отметки).
 * Запись — `admin` и `content_manager`, «прочитано» — только `admin` (решение арбитра R5).
 */
@ApiTags('world')
@Controller()
export class BookWorldController {
  constructor(private readonly service: BookWorldService) {}

  @Get('versions/:bookVersionId/world')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'World of a book version: public entities for readers, every entity with marks for editors (drafts are visible to editors only)',
  })
  @ApiOkResponse({ type: BookWorldListResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @UseGuards(OptionalJwtAuthGuard)
  list(
    @Param('bookVersionId') bookVersionId: string,
    @Query() query: ListBookWorldQueryDto,
    @Req() req?: ActorRequest,
  ) {
    return this.service.getList(bookVersionId, req?.user, { map: query.map !== undefined });
  }

  @Get('versions/:bookVersionId/world/:key')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'World entity page; 404 for readers when the version is a draft or the entity is not public',
  })
  @ApiOkResponse({ type: BookWorldEntityResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiParam({ name: 'key' })
  @UseGuards(OptionalJwtAuthGuard)
  get(
    @Param('bookVersionId') bookVersionId: string,
    @Param('key') key: string,
    @Req() req?: ActorRequest,
  ) {
    return this.service.getEntity(bookVersionId, key, req?.user);
  }

  @Put('versions/:bookVersionId/world')
  @ApiOperation({
    summary:
      'Import the world of a version (JSON import format, merge by entity key; entities absent from the body are kept); dryRun=true writes nothing; 409 RECORD_CHANGED when the version world is not what the tab saw (expectedUpdatedAt = latest entity updatedAt, expectedCount = number of entities, expectedAbsent = no entities)',
  })
  @ApiOkResponse({ type: BookWorldSaveResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  saveVersion(
    @Param('bookVersionId') bookVersionId: string,
    @Query() query: SaveBookWorldVersionQueryDto,
    @Body() dto: UpdateBookWorldDto,
  ) {
    return this.service.saveVersion(bookVersionId, dto, query.dryRun === 'true', query);
  }

  @Put('versions/:bookVersionId/world/:key')
  @ApiOperation({
    summary:
      'Create or merge one world entity (body key, if present, must equal the path); dryRun=true writes nothing; 409 RECORD_CHANGED when the entity is not what the tab saw',
  })
  @ApiOkResponse({ type: BookWorldEntitySaveResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiParam({ name: 'key' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  saveEntity(
    @Param('bookVersionId') bookVersionId: string,
    @Param('key') key: string,
    @Query() query: SaveBookWorldQueryDto,
    @Body() dto: UpdateBookWorldEntityDto,
  ) {
    return this.service.saveEntity(bookVersionId, key, dto, query.dryRun === 'true', query);
  }

  @Delete('versions/:bookVersionId/world/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a world entity; 409 WORLD_ENTITY_PUBLISHED once it has been on the site (hide it instead), 409 WORLD_ENTITY_REFERENCED while other entities refer to it',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiParam({ name: 'key' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async remove(@Param('bookVersionId') bookVersionId: string, @Param('key') key: string) {
    await this.service.remove(bookVersionId, key);
  }

  @Post('versions/:bookVersionId/world/:key/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark the model text of a world entity as read (admin only); 409 AUTO_TEXT_NONE without model text, 409 WORLD_TEXT_CHANGED when autoTextAt is not the latest one',
  })
  @ApiOkResponse({ type: BookWorldEntitySummaryDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiParam({ name: 'key' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  markRead(
    @Param('bookVersionId') bookVersionId: string,
    @Param('key') key: string,
    @Body() dto: MarkWorldReadDto,
  ) {
    return this.service.markRead(bookVersionId, key, dto);
  }

  @Patch('versions/:bookVersionId/world/:key/flags')
  @ApiOperation({ summary: 'Set "show" (isVisible) and "index" (isIndexable) of a world entity' })
  @ApiOkResponse({ type: BookWorldEntitySummaryDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiParam({ name: 'key' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  setFlags(
    @Param('bookVersionId') bookVersionId: string,
    @Param('key') key: string,
    @Body() dto: SetWorldFlagsDto,
  ) {
    return this.service.setFlags(bookVersionId, key, dto);
  }
}
