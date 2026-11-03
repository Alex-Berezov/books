import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
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
import { Prisma } from '@prisma/client';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  ContentDraftDto,
  ContentDraftEstimateDto,
  ContentDraftStateDto,
} from '../dto/content-draft-response.dto';
import { StartContentDraftDto } from '../dto/content-draft-request.dto';
import { AcceptSummaryItemDto, RegenerateSummaryItemDto } from '../dto/summary-write-request.dto';
import {
  SummaryWriteDto,
  SummaryWriteEstimateDto,
  SummaryWriteStateDto,
} from '../dto/summary-write-response.dto';
import { SummaryWriteService } from '../summary-write/summary-write.service';
import { CONTENT_DRAFT_KINDS, DraftKind } from './content-draft.constants';
import { ContentDraftService } from './content-draft.service';

interface RequestUser {
  userId: string;
}

/**
 * Вид в адресе: `analysis` (`F05-11`); снятые виды Summary `F05-10` и иной - 400 (решение арбитра
 * `F06 | F06-3`, А2).
 */
const KIND_PIPE = new ParseEnumPipe(
  Object.fromEntries(CONTENT_DRAFT_KINDS.map((k) => [k, k])) as Record<DraftKind, DraftKind>,
);

const WRITE_START_CONFLICTS =
  'DRAFT_IN_PROGRESS: a summary run is being built; SOURCE_HAS_NO_CHAPTERS: the version has no chapter text; DOSSIER_STALE: the source changed after the dossier, rebuild it; RUN_LANGUAGE_UNFINISHED: the translation run is still writing this version; DRAFT_DOSSIER_MISSING: the run dossier of a translated version is gone; LLM_CEILING_REACHED: the spending ceiling is reached; DOSSIER_TOO_LONG: the dossier is not built and its summary is refused at the start (estimate dossier.refusedTooLong); LLM_NO_PRICE; LLM_STAGE_DISABLED';

const ITEM_CONFLICTS =
  'SUMMARY_WRITE_NOT_READY: the run is building, failed or discarded; SUMMARY_REGEN_IN_PROGRESS: this text is being regenerated';

const START_CONFLICTS =
  'DRAFT_IN_PROGRESS: a draft of this kind is being built; DOSSIER_STALE: the source changed after the dossier, rebuild it; RUN_LANGUAGE_UNFINISHED: the translation run is still writing this version; DRAFT_DOSSIER_MISSING: the run dossier of a translated version is gone; LLM_CEILING_REACHED: the spending ceiling is reached; DOSSIER_TOO_LONG: the dossier is not built and its summary is refused at the start (estimate dossier.refusedTooLong); SOURCE_HAS_NO_CHAPTERS; DRAFT_TOO_LONG: the version text does not fit the context of the analysis model; LLM_NO_PRICE; LLM_STAGE_DISABLED';

/**
 * Заготовка Analysis (`F05-11`) из досье - только `admin` (U6): оценка, старт фоном под своей
 * операцией, последняя заготовка вида и «не нужна». В анализ версии не пишет - черновик сохраняет
 * редактор ручками Analysis. Пошаговые заготовки Summary `F05-10` сняты в `F06-3`. Здесь же ручки хода
 * пересказа «Write Summary» (`F06-2`): он пишет в пустые поля пересказа и принимает предложения
 * («Accept») - литеральные маршруты `summary_write` объявлены выше `:kind`.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class ContentDraftController {
  constructor(
    private readonly drafts: ContentDraftService,
    private readonly summaryWrite: SummaryWriteService,
  ) {}

  // Ход пересказа «Write Summary» (`F06-2`, `tech.md` §6): литеральные маршруты выше `:kind`, иначе
  // вид ушёл бы в `KIND_PIPE` и ответил 400.

  @Get('versions/:id/drafts/summary_write/estimate')
  @ApiOperation({
    summary:
      'Upper cost estimate of the summary run: every section of the dossier plan, the full and the very short summary, each text × 2 passes of the author and the reviewer',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SummaryWriteEstimateDto })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: WRITE_START_CONFLICTS })
  writeEstimate(@Param('id') id: string): Promise<SummaryWriteEstimateDto> {
    return this.summaryWrite.estimate(id);
  }

  @Get('versions/:id/drafts/summary_write')
  @ApiOperation({
    summary:
      'The latest summary run that is not discarded, in any status: its texts, flags, what is written and what is proposed; null - none',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SummaryWriteStateDto })
  writeLatest(@Param('id') id: string): Promise<SummaryWriteStateDto> {
    return this.summaryWrite.latest(id);
  }

  @Post('versions/:id/drafts/summary_write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      '«Write Summary»: the sections of the dossier plan, then the full and the very short summary, in the background under its own operation; empty fields of an unpublished version are written, the rest become proposals; the previous ready or failed run is discarded',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ type: SummaryWriteDto })
  @ApiBadRequestResponse({
    description: 'DRAFT_LIMIT_TOO_LOW: below the limits of the dossier and glossary built first',
  })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: WRITE_START_CONFLICTS })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  writeStart(
    @Param('id') id: string,
    @Body() dto: StartContentDraftDto,
    @Req() req: { user: RequestUser },
  ): Promise<SummaryWriteDto> {
    return this.summaryWrite.start(
      id,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      req.user.userId,
    );
  }

  @Post('content-drafts/:id/items/:index/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Regenerate one text of a ready summary run under its own operation, with the editor remark in the author prompt; the first text of a section also builds the full and the very short summary',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiAcceptedResponse({ type: SummaryWriteDto })
  @ApiBadRequestResponse({ description: 'SUMMARY_ITEM_UNKNOWN: the run has no such text' })
  @ApiNotFoundResponse({ description: 'Summary run not found' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; SUMMARY_SECTIONS_UNFINISHED: not every section has a text (full); SUMMARY_FULL_UNFINISHED: no full summary with a text (brief); LLM_CEILING_REACHED`,
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  regenerate(
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: RegenerateSummaryItemDto,
    @Req() req: { user: RequestUser },
  ): Promise<SummaryWriteDto> {
    return this.summaryWrite.regenerate(id, index, dto.remark || null, req.user.userId);
  }

  @Post('content-drafts/:id/items/:index/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept a proposal of the summary run into its field when the field has not changed since; a section replaces the section of the same number, numbering never changes; beyond the last section - added at the end',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiOkResponse({ type: SummaryWriteDto })
  @ApiBadRequestResponse({ description: 'SUMMARY_ITEM_UNKNOWN: the run has no such text' })
  @ApiNotFoundResponse({ description: 'Summary run not found' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; SUMMARY_ITEM_NOT_PROPOSED: not a proposal; SUMMARY_FIELD_CHANGED: the field changed after the proposal (current - its content); SUMMARY_CHAPTER_CHANGE: the section moves to other reader chapters, repeat with confirmChapterChange`,
  })
  accept(
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: AcceptSummaryItemDto,
  ): Promise<SummaryWriteDto> {
    return this.summaryWrite.accept(id, index, dto.confirmChapterChange === true);
  }

  @Post('content-drafts/:id/items/:index/discard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Discard a proposal of the summary run: the field is not touched' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiOkResponse({ type: SummaryWriteDto })
  @ApiBadRequestResponse({ description: 'SUMMARY_ITEM_UNKNOWN: the run has no such text' })
  @ApiNotFoundResponse({ description: 'Summary run not found' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; SUMMARY_ITEM_NOT_PROPOSED: not a proposal`,
  })
  discardItem(
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<SummaryWriteDto> {
    return this.summaryWrite.discardItem(id, index);
  }

  @Post('content-drafts/:id/discard-run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Discard a summary run: one being built cancels its operation; the regenerations of its texts are cancelled; the fields are not touched',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SummaryWriteDto })
  @ApiNotFoundResponse({ description: 'Summary run not found (a draft of another kind too)' })
  discardRun(@Param('id') id: string): Promise<SummaryWriteDto> {
    return this.summaryWrite.discard(id);
  }

  @Post('content-drafts/:id/accept-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept all proposals of the summary run one by one: sections by number, then the full and the very short summary',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: SummaryWriteDto })
  @ApiNotFoundResponse({ description: 'Summary run not found' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; ACCEPT_ALL_CHAPTER_CHANGE: a section moves to other reader chapters, accept it alone; SUMMARY_FIELD_CHANGED: a field changed after its proposal`,
  })
  acceptAll(@Param('id') id: string): Promise<SummaryWriteDto> {
    return this.summaryWrite.acceptAll(id);
  }

  @Get('versions/:id/drafts/:kind/estimate')
  @ApiOperation({ summary: 'Upper cost estimate of an analysis draft from the dossier' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: CONTENT_DRAFT_KINDS })
  @ApiOkResponse({ type: ContentDraftEstimateDto })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: START_CONFLICTS })
  estimate(
    @Param('id') id: string,
    @Param('kind', KIND_PIPE) kind: DraftKind,
  ): Promise<ContentDraftEstimateDto> {
    return this.drafts.estimate(id, kind);
  }

  @Get('versions/:id/drafts/:kind')
  @ApiOperation({
    summary:
      'The latest analysis draft that is not discarded, in any status (building, ready, failed); null - none',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: CONTENT_DRAFT_KINDS })
  @ApiOkResponse({ type: ContentDraftStateDto })
  latest(
    @Param('id') id: string,
    @Param('kind', KIND_PIPE) kind: DraftKind,
  ): Promise<ContentDraftStateDto> {
    return this.drafts.latest(id, kind);
  }

  @Post('versions/:id/drafts/:kind')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Build an analysis draft in the background under its own operation; the dossier and glossary are built first when missing; the previous ready or failed draft of this kind is discarded',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: CONTENT_DRAFT_KINDS })
  @ApiAcceptedResponse({ type: ContentDraftDto })
  @ApiBadRequestResponse({
    description: 'DRAFT_LIMIT_TOO_LOW: below the limits of the dossier and glossary built first',
  })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: START_CONFLICTS })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  start(
    @Param('id') id: string,
    @Param('kind', KIND_PIPE) kind: DraftKind,
    @Body() dto: StartContentDraftDto,
    @Req() req: { user: RequestUser },
  ): Promise<ContentDraftDto> {
    return this.drafts.start(
      id,
      kind,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      req.user.userId,
    );
  }

  @Post('content-drafts/:id/discard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Discard a draft: a draft being built cancels its operation; the dossier and glossary are not cancelled; a summary run is discarded by discard-run',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ContentDraftDto })
  @ApiNotFoundResponse({ description: 'Content draft not found' })
  discard(@Param('id') id: string): Promise<ContentDraftDto> {
    return this.drafts.discard(id);
  }
}
