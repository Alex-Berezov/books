import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  EditTranslationChunkDto,
  RetryTranslationChunkDto,
  TranslationChunkEditedDto,
  TranslationChunkRetryStartedDto,
  TranslationChunksDto,
  TranslationChunksQueryDto,
} from '../dto/translation-chunk.dto';
import { ChunkRetryService } from './chunk-retry.service';

interface RequestUser {
  userId: string;
}

/**
 * Куски языка запуска (`F05-7v`) в админке - только `admin` (U6): «оригинал | перевод» по
 * главе, повтор куска под своей операцией с лимитом и правка руками.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class TranslationChunksController {
  constructor(private readonly chunks: ChunkRetryService) {}

  @Get('translation-runs/:id/chunks')
  @ApiOperation({
    summary:
      'Pieces of one chapter of a run language side by side: source and translation block to block, status, flag, model, cost, retry and hand edit; the chapter rewrite refusal and its findings',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationChunksDto })
  @ApiNotFoundResponse({
    description: 'Translation run not found, or it does not translate to lang',
  })
  listChunks(
    @Param('id') id: string,
    @Query() query: TranslationChunksQueryDto,
  ): Promise<TranslationChunksDto> {
    return this.chunks.list(id, query.lang, query.chapter);
  }

  @Post('translation-chunks/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Retry a piece anew with checks under its own operation and limit, optionally with another translate model; the piece and the draft chapter are replaced when the retry ends',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ type: TranslationChunkRetryStartedDto })
  @ApiBadRequestResponse({ description: 'LLM_MODEL_UNKNOWN; limitUsd not an amount' })
  @ApiNotFoundResponse({ description: 'Translation chunk not found' })
  @ApiConflictResponse({
    description:
      'RUN_ACTIVE: the run is running, pause it; RETRY_IN_PROGRESS: a retry of this language is in progress; DRAFT_MISSING: the language has no draft; CHUNK_SOURCE_CHANGED: the source chapter changed after the split; LLM_NO_PRICE; LLM_STAGE_DISABLED; CHECK_MODEL_SAME_FAMILY',
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  retryChunk(
    @Param('id') id: string,
    @Body() dto: RetryTranslationChunkDto,
    @Req() req: { user: RequestUser },
  ): Promise<TranslationChunkRetryStartedDto> {
    return this.chunks.retry(id, dto, req.user.userId);
  }

  @Put('translation-chunks/:id')
  @ApiOperation({
    summary:
      'Edit a piece by hand: the translation of each block of the piece, inline markup only; the piece is saved, the draft chapter is rewritten unless refused (reason)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationChunkEditedDto })
  @ApiBadRequestResponse({
    description:
      'CHUNK_BLOCKS_INVALID: blocks not of the piece, repeated, missing or empty after markup cleaning',
  })
  @ApiNotFoundResponse({ description: 'Translation chunk not found' })
  @ApiConflictResponse({
    description:
      'RUN_ACTIVE; RETRY_IN_PROGRESS; DRAFT_MISSING; CHUNK_SOURCE_CHANGED: the source chapter changed after the split; CHUNK_EDIT_CONFLICT: the chapter or piece changed concurrently, try again',
  })
  editChunk(
    @Param('id') id: string,
    @Body() dto: EditTranslationChunkDto,
  ): Promise<TranslationChunkEditedDto> {
    return this.chunks.edit(id, dto);
  }
}
