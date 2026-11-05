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
  ApiExtraModels,
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
import {
  AnalysisWriteDto,
  AnalysisWriteEstimateDto,
  AnalysisWriteStateDto,
  AnalysisWriteValueDto,
} from '../dto/analysis-write-response.dto';
import { AnalysisWriteService } from '../analysis-write/analysis-write.service';
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

const ITEM_CONFLICTS =
  'SUMMARY_WRITE_NOT_READY: the run is building, failed or discarded; SUMMARY_REGEN_IN_PROGRESS: this text is being regenerated';

const ANALYSIS_ITEM_CONFLICTS =
  'ANALYSIS_WRITE_NOT_READY: the run is building, failed or discarded; ANALYSIS_REGEN_IN_PROGRESS: this block is being regenerated';

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
@ApiExtraModels(SummaryWriteDto, AnalysisWriteDto)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class ContentDraftController {
  constructor(
    private readonly drafts: ContentDraftService,
    private readonly summaryWrite: SummaryWriteService,
    private readonly analysisWrite: AnalysisWriteService,
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
  // литеральные маршруты выше `:kind` (решение арбитра `F07 | F07-1`, В6); `CONTENT_DRAFT_KINDS`
  // не расширяется. Предложения, «Accept», «Regenerate» и отмена хода - общие ручки
  // `content-drafts/:id/*` ниже, вид строки выбирает `byKind`; содержимое предложения хода
  // анализа - `GET content-drafts/:id/items/:index`.

  @Get('versions/:id/drafts/analysis_write/estimate')
  @ApiOperation({
    summary:
      'Upper cost estimate of the analysis run: steps 1-3, each reads the whole version text, plus the reviewer of each step, each step × 2 passes of the author and the reviewer',
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
      '«Write Analysis»: steps 1-3 (card and characters, key quotations and style, interpretations) in the background under its own operation; blocks empty at the start of an unpublished version are written through the import, the rest become proposals; the previous ready or failed run is discarded',
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
    @Param('id') id: string,
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
    @Param('id') id: string,
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
    description: `${ITEM_CONFLICTS}; SUMMARY_ITEM_NOT_PROPOSED: not a proposal; SUMMARY_FIELD_CHANGED: the field changed after the proposal (current - its content); SUMMARY_CHAPTER_CHANGE: the section moves to other reader chapters, repeat with confirmChapterChange; ${ANALYSIS_ITEM_CONFLICTS}; ANALYSIS_ITEM_NOT_PROPOSED: not a proposal; ANALYSIS_BLOCK_CHANGED: the block changed after the proposal (current - its content); ANALYSIS_WRITE_REFUSED: the analysis refused the write, the references do not fit (errors)`,
  })
  async accept(
    @Param('id') id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: AcceptSummaryItemDto,
  ): Promise<SummaryWriteDto | AnalysisWriteDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.accept(id, index, dto.confirmChapterChange === true),
      () => this.analysisWrite.accept(id, index),
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
    @Param('id') id: string,
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
  async discardRun(@Param('id') id: string): Promise<SummaryWriteDto | AnalysisWriteDto> {
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
  @ApiOkResponse(RUN_RESPONSE)
  @ApiNotFoundResponse({ description: 'Run not found (a draft of another kind too)' })
  @ApiConflictResponse({
    description: `${ITEM_CONFLICTS}; ACCEPT_ALL_CHAPTER_CHANGE: a section moves to other reader chapters, accept it alone; SUMMARY_FIELD_CHANGED: a field changed after its proposal; ANALYSIS_WRITE_NOT_READY: the analysis run is not ready (acceptedIndexes - what is written already). An analysis proposal refused on its own (ANALYSIS_WRITE_REFUSED, ANALYSIS_BLOCK_CHANGED, ANALYSIS_REGEN_IN_PROGRESS) is skipped: it stays a proposal and the answer is 200`,
  })
  async acceptAll(@Param('id') id: string): Promise<SummaryWriteDto | AnalysisWriteDto> {
    return this.byKind(
      id,
      () => this.summaryWrite.acceptAll(id),
      () => this.analysisWrite.acceptAll(id),
    );
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
