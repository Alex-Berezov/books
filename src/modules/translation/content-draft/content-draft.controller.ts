import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { StartContentDraftDto } from '../dto/content-draft-request.dto';
import { AcceptSummaryItemDto, RegenerateSummaryItemDto } from '../dto/summary-write-request.dto';
import {
  SummaryWriteDto,
  SummaryWriteEstimateDto,
  SummaryWriteStateDto,
} from '../dto/summary-write-response.dto';
import { SummaryWriteService } from '../summary-write/summary-write.service';
import {
  AnalysisAcceptAllDto,
  AnalysisWriteDto,
  AnalysisWriteEstimateDto,
  AnalysisWriteStateDto,
  AnalysisWriteValueDto,
} from '../dto/analysis-write-response.dto';
import { AnalysisWriteService } from '../analysis-write/analysis-write.service';
import { MarkAutoTextReadDto } from '../dto/auto-text-read-request.dto';
import { AutoTextReadDto } from '../dto/auto-text-read-response.dto';
import {
  AUTO_TEXT_RUN_KINDS,
  autoTextKindOfRun,
  type AutoTextRunKind,
} from './content-draft.constants';
import { AutoTextReadService } from './auto-text-read.service';
import { ContentDraftService } from './content-draft.service';

interface RequestUser {
  userId: string;
}

/** Общие части описаний отказов: версия без текста, контекст досье и глоссария, цена этапов. */
const NO_CHAPTERS_CONFLICT = 'SOURCE_HAS_NO_CHAPTERS: the version has no chapter text';
const CONTEXT_CONFLICTS =
  'DOSSIER_STALE: the source changed after the dossier, rebuild it; RUN_LANGUAGE_UNFINISHED: the translation run is still writing this version; DRAFT_DOSSIER_MISSING: the run dossier of a translated version is gone';
const SPEND_CONFLICTS =
  'LLM_CEILING_REACHED: the spending ceiling is reached; DOSSIER_TOO_LONG: the dossier is not built and its summary is refused at the start (estimate dossier.refusedTooLong)';
const STAGE_CONFLICTS = 'LLM_NO_PRICE; LLM_STAGE_DISABLED';

const WRITE_START_CONFLICTS = [
  'DRAFT_IN_PROGRESS: a summary run is being built',
  NO_CHAPTERS_CONFLICT,
  CONTEXT_CONFLICTS,
  SPEND_CONFLICTS,
  STAGE_CONFLICTS,
].join('; ');

/**
 * Отказы старта хода анализа - те же, что у хода пересказа (решение арбитра `F07 | F07-1a`, К2):
 * строка собирается из тех же частей, а не копией и не подменой по тексту.
 */
const ANALYSIS_START_CONFLICTS = [
  'DRAFT_IN_PROGRESS: an analysis run is being built',
  NO_CHAPTERS_CONFLICT,
  CONTEXT_CONFLICTS,
  SPEND_CONFLICTS,
  STAGE_CONFLICTS,
  'DRAFT_TOO_LONG is not a start refusal: a step whose input does not fit even as chapter summaries is marked with it and the run goes on',
].join('; ');

/**
 * Отказы оценки хода анализа - только то, что бросает `AnalysisWriteService.estimateOf`: версия
 * без текста глав (или источник досье без них), отказы контекста `draftContext` и оценщиков
 * этапов. Потолка, строящегося хода и отказа сводки досье оценка не бросает: `refusedTooLong` -
 * поле ответа.
 */
const ANALYSIS_ESTIMATE_CONFLICTS = [
  'SOURCE_HAS_NO_CHAPTERS: the version or the dossier source has no chapter text',
  CONTEXT_CONFLICTS,
  STAGE_CONFLICTS,
].join('; ');

/** Ответ общих ручек решений по ходу: форма зависит от вида строки (`F07-1b`, В6). */
const RUN_RESPONSE = {
  schema: {
    oneOf: [{ $ref: getSchemaPath(SummaryWriteDto) }, { $ref: getSchemaPath(AnalysisWriteDto) }],
  },
};

/** Ответ «Accept all»: ход анализа - со списком пропущенных пунктов (решение арбитра `F07 | F07-3`, п.7). */
const ACCEPT_ALL_RESPONSE = {
  schema: {
    oneOf: [
      { $ref: getSchemaPath(SummaryWriteDto) },
      { $ref: getSchemaPath(AnalysisAcceptAllDto) },
    ],
  },
};

/** Вид хода в маршруте отметки «прочитано» - вид автотекста версии (`T184`). */
const READ_RUN_KINDS = Object.values(AUTO_TEXT_RUN_KINDS);
const READ_KIND_PIPE = new ParseEnumPipe(
  Object.fromEntries(READ_RUN_KINDS.map((kind) => [kind, kind])),
);

const ITEM_CONFLICTS =
  'SUMMARY_WRITE_NOT_READY: the run is building, failed or discarded; SUMMARY_REGEN_IN_PROGRESS: this text is being regenerated';

const ANALYSIS_ITEM_CONFLICTS =
  'ANALYSIS_WRITE_NOT_READY: the run is building, failed or discarded; ANALYSIS_REGEN_IN_PROGRESS: this block is being regenerated';

/**
 * Ходы «Write Summary» (`F06-2`) и «Write Analysis» (`F07-1a`) - только `admin` (U6): оценка,
 * старт, ход, предложения, «Accept», «Regenerate», отмена и отметка редактора «прочитано»
 * (`versions/:id/drafts/:kind/read`, `T184`). Заготовки из досье сняты все
 * (Summary `F05-10` в `F06-3`, Analysis `F05-11` в `F07-3a`, решение арбитра `F07 | F07-3`):
 * маршрутов `drafts/:kind` и `content-drafts/:id/discard` больше нет.
 */
@ApiTags('admin')
@ApiBearerAuth()
@ApiExtraModels(SummaryWriteDto, AnalysisWriteDto, AnalysisAcceptAllDto)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class ContentDraftController {
  constructor(
    private readonly drafts: ContentDraftService,
    private readonly summaryWrite: SummaryWriteService,
    private readonly analysisWrite: AnalysisWriteService,
    private readonly autoTextRead: AutoTextReadService,
  ) {}

  /**
   * Развилка общих ручек `content-drafts/:id/*` по виду строки хода (`F07-1b`, решение арбитра
   * `F07 | F07-1`, В6): одна выборка вида, дальше - сервис своего вида; иной вид или нет строки -
   * 404 (`runKindOf`).
   */
  private async byKind<S, A>(
    id: string,
    summary: () => Promise<S>,
    analysis: () => Promise<A>,
  ): Promise<S | A> {
    return (await this.drafts.runKindOf(id)) === 'analysis_write' ? analysis() : summary();
  }

  // Ход анализа «Write Analysis» (`F07-1a`, `features/F07-analysis-autofill/tech.md` §5-§6):
  // свои литеральные маршруты (решение арбитра `F07 | F07-1`, В6). Предложения, «Accept»,
  // «Regenerate» и отмена хода - общие ручки `content-drafts/:id/*` ниже, вид строки выбирает
  // `byKind`; содержимое предложения хода анализа - `GET content-drafts/:id/items/:index`.

  @Get('versions/:id/drafts/analysis_write/estimate')
  @ApiOperation({
    summary:
      'Upper cost estimate of the analysis run: steps 1-5, each reads the whole version text, plus the reviewer of each step, each step × 2 passes of the author and the reviewer',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AnalysisWriteEstimateDto })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: ANALYSIS_ESTIMATE_CONFLICTS })
  analysisEstimate(@Param('id') id: string): Promise<AnalysisWriteEstimateDto> {
    return this.analysisWrite.estimate(id);
  }

  @Get('versions/:id/drafts/analysis_write')
  @ApiOperation({
    summary:
      'The latest analysis run that is not discarded, in any status: its steps, flags, dropped quotations, what is written and what is proposed; null - none',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AnalysisWriteStateDto })
  analysisLatest(@Param('id') id: string): Promise<AnalysisWriteStateDto> {
    return this.analysisWrite.latest(id);
  }

  @Post('versions/:id/drafts/analysis_write')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      '«Write Analysis»: steps 1-5 (card and characters, key quotations and style, interpretations, blocks for the reader, external blocks with checked sources) in the background under its own operation; blocks empty at the start of an unpublished version are written through the import, the rest become proposals; the previous ready or failed run is discarded',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ type: AnalysisWriteDto })
  @ApiBadRequestResponse({
    description: 'DRAFT_LIMIT_TOO_LOW: below the limits of the dossier and glossary built first',
  })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: ANALYSIS_START_CONFLICTS })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  analysisStart(
    @Param('id') id: string,
    @Body() dto: StartContentDraftDto,
    @Req() req: { user: RequestUser },
  ): Promise<AnalysisWriteDto> {
    return this.analysisWrite.start(
      id,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      req.user.userId,
    );
  }

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

  // Отметка редактора «прочитано» (`T184`; решение арбитра 12.11.2026 `T184 | LEGACY-493 |
  // LEGACY-495`): без неё публикация версии с текстом модели в полях вкладки отказывает
  // `AUTO_TEXT_NOT_READ`. Текст модели, легший после отметки, снимает её сам.

  @Get('versions/:id/drafts/:kind/read')
  @ApiOperation({
    summary:
      'The editor «read» mark of the Summary or Analysis tab: when model text last landed in its fields and when the editor marked it read',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: READ_RUN_KINDS })
  @ApiOkResponse({ type: AutoTextReadDto })
  @ApiBadRequestResponse({ description: 'Not a UUID or not a run kind' })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  readState(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('kind', READ_KIND_PIPE) kind: AutoTextRunKind,
  ): Promise<AutoTextReadDto> {
    return this.autoTextRead.state(id, autoTextKindOfRun(kind));
  }

  @Post('versions/:id/drafts/:kind/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark the model text of the Summary or Analysis tab read: publication of the version stops refusing AUTO_TEXT_NOT_READ for this tab until model text lands again',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: READ_RUN_KINDS })
  @ApiOkResponse({ type: AutoTextReadDto })
  @ApiBadRequestResponse({ description: 'Not a UUID, not a run kind or autoTextAt is not a date' })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({
    description:
      'AUTO_TEXT_RUN_BUILDING: a run of this kind is still writing; AUTO_TEXT_NONE: no model text has landed in these fields; AUTO_TEXT_CHANGED: newer model text landed than the autoTextAt the editor saw (current - the state now)',
  })
  markRead(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('kind', READ_KIND_PIPE) kind: AutoTextRunKind,
    @Body() dto: MarkAutoTextReadDto,
    @Req() req: { user: RequestUser },
  ): Promise<AutoTextReadDto> {
    return this.autoTextRead.mark(id, autoTextKindOfRun(kind), req.user.userId, dto.autoTextAt);
  }

  @Delete('versions/:id/drafts/:kind/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove the «read» mark of the Summary or Analysis tab' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: READ_RUN_KINDS })
  @ApiNoContentResponse({ description: 'The mark is removed' })
  @ApiBadRequestResponse({ description: 'Not a UUID or not a run kind' })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  unmarkRead(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('kind', READ_KIND_PIPE) kind: AutoTextRunKind,
  ): Promise<void> {
    return this.autoTextRead.unmark(id, autoTextKindOfRun(kind));
  }

  @Get('content-drafts/:id/items/:index')
  @ApiOperation({
    summary:
      'The content of a proposal of a ready analysis run: one field by the kind of the block, the others null; the run answer does not carry it',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiOkResponse({ type: AnalysisWriteValueDto })
  @ApiBadRequestResponse({ description: 'ANALYSIS_ITEM_UNKNOWN: the run has no such block' })
  @ApiNotFoundResponse({
    description: 'Analysis run not found (a summary run and a draft of another kind too)',
  })
  @ApiConflictResponse({
    description:
      'ANALYSIS_WRITE_NOT_READY: the run is building, failed or discarded; ANALYSIS_ITEM_NOT_PROPOSED: the block is not a proposal',
  })
  async proposal(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<AnalysisWriteValueDto> {
    // Одна выборка строки - в сервисе анализа: ход пересказа (его текст - в его ответе), заготовка и
    // иной вид - 404 там же.
    return this.analysisWrite.proposal(id, index);
  }

  @Post('content-drafts/:id/items/:index/regenerate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Regenerate one text of a ready summary run (the first text of a section also builds the full and the very short summary) or one block of a ready analysis run (sources of a step 5 block are opened again and added to the sources), under its own operation, with the editor remark in the author prompt; the kind of the run is taken from its row',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiAcceptedResponse(RUN_RESPONSE)
  @ApiBadRequestResponse({
    description: 'SUMMARY_ITEM_UNKNOWN, ANALYSIS_ITEM_UNKNOWN: the run has no such text or block',
  })
  @ApiNotFoundResponse({ description: 'Run not found (a draft of another kind too)' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; SUMMARY_SECTIONS_UNFINISHED: not every section has a text (full); SUMMARY_FULL_UNFINISHED: no full summary with a text (brief); ${ANALYSIS_ITEM_CONFLICTS}; ANALYSIS_ITEM_NOT_REGENERABLE: theme links and sources are not regenerated on their own; LLM_CEILING_REACHED`,
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  async regenerate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: RegenerateSummaryItemDto,
    @Req() req: { user: RequestUser },
  ): Promise<SummaryWriteDto | AnalysisWriteDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.regenerate(id, index, dto.remark || null, req.user.userId),
      () => this.analysisWrite.regenerate(id, index, dto.remark || null, req.user.userId),
    );
  }

  @Post('content-drafts/:id/items/:index/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept a proposal of the summary run into its field when the field has not changed since (a section replaces the section of the same number, numbering never changes; beyond the last section - added at the end), or a proposal of the analysis run into its block when the content of the block has not changed since; the kind of the run is taken from its row',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiOkResponse(RUN_RESPONSE)
  @ApiBadRequestResponse({
    description: 'SUMMARY_ITEM_UNKNOWN, ANALYSIS_ITEM_UNKNOWN: the run has no such text or block',
  })
  @ApiNotFoundResponse({ description: 'Run not found (a draft of another kind too)' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; SUMMARY_ITEM_NOT_PROPOSED: not a proposal; SUMMARY_FIELD_CHANGED: the field changed after the proposal (current - its content); SUMMARY_CHAPTER_CHANGE: the section moves to other reader chapters, repeat with confirmChapterChange; ${ANALYSIS_ITEM_CONFLICTS}; ANALYSIS_ITEM_NOT_PROPOSED: not a proposal; ANALYSIS_BLOCK_CHANGED: the block changed after the proposal (current - its content); ANALYSIS_PROPOSAL_CHANGED: the proposal is not the one with expectedPrint (it was regenerated); ANALYSIS_WRITE_REFUSED: the analysis refused the write, the references do not fit (errors)`,
  })
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: AcceptSummaryItemDto,
  ): Promise<SummaryWriteDto | AnalysisWriteDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.accept(id, index, dto.confirmChapterChange === true),
      () => this.analysisWrite.accept(id, index, dto.expectedPrint),
    );
  }

  @Post('content-drafts/:id/items/:index/discard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Discard a proposal of a summary or analysis run: the field or the block is not touched',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'index', type: Number })
  @ApiOkResponse(RUN_RESPONSE)
  @ApiBadRequestResponse({
    description: 'SUMMARY_ITEM_UNKNOWN, ANALYSIS_ITEM_UNKNOWN: the run has no such text or block',
  })
  @ApiNotFoundResponse({ description: 'Run not found (a draft of another kind too)' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; SUMMARY_ITEM_NOT_PROPOSED: not a proposal; ${ANALYSIS_ITEM_CONFLICTS}; ANALYSIS_ITEM_NOT_PROPOSED: not a proposal`,
  })
  async discardItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
  ): Promise<SummaryWriteDto | AnalysisWriteDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.discardItem(id, index),
      () => this.analysisWrite.discardItem(id, index),
    );
  }

  @Post('content-drafts/:id/discard-run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Discard a summary or analysis run: one being built cancels its operation; the regenerations of its texts or blocks are cancelled; the fields and the blocks are not touched',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse(RUN_RESPONSE)
  @ApiNotFoundResponse({ description: 'Run not found (a draft of another kind too)' })
  @ApiConflictResponse({
    description:
      'ANALYSIS_REGEN_IN_PROGRESS: an analysis run - a regeneration of its blocks keeps starting while the run is discarded, discard again',
  })
  async discardRun(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SummaryWriteDto | AnalysisWriteDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.discard(id),
      () => this.analysisWrite.discard(id),
    );
  }

  @Post('content-drafts/:id/accept-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept all proposals of the run one by one: a summary run - sections by number, then the full and the very short summary; an analysis run - interpretations, characters, key quotations, then the theme links',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse(ACCEPT_ALL_RESPONSE)
  @ApiNotFoundResponse({ description: 'Run not found (a draft of another kind too)' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; ACCEPT_ALL_CHAPTER_CHANGE: a section moves to other reader chapters, accept it alone; SUMMARY_FIELD_CHANGED: a field changed after its proposal; a refusal in the middle of the pass carries acceptedIndexes and stoppedIndex (the item the pass stopped on); ANALYSIS_WRITE_NOT_READY: the analysis run is not ready (skipped - the items left as proposals before the stop). An analysis proposal refused on its own (ANALYSIS_WRITE_REFUSED, ANALYSIS_BLOCK_CHANGED, ANALYSIS_REGEN_IN_PROGRESS) is skipped: it stays a proposal, the answer is 200 and lists it in skipped with its code`,
  })
  async acceptAll(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SummaryWriteDto | AnalysisAcceptAllDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.acceptAll(id),
      () => this.analysisWrite.acceptAll(id),
    );
  }
}
