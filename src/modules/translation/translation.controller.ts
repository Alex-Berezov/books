import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
} from '@nestjs/swagger';
import { Language, Prisma } from '@prisma/client';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { PaginatedResult, paginatedSchema } from '../../shared/dto/paginated-response.dto';
import { TranslationCompareService } from './compare/compare.service';
import { StartDossierDto } from './dto/start-dossier.dto';
import {
  StartTranslationCompareDto,
  TranslationCompareEstimateQueryDto,
} from './dto/translation-compare-request.dto';
import {
  TranslationCompareDto,
  TranslationCompareEstimateDto,
  TranslationCompareListItemDto,
} from './dto/translation-compare-response.dto';
import {
  ResumeTranslationRunDto,
  StartTranslationRunDto,
  TranslationRunEstimateQueryDto,
} from './dto/translation-run-request.dto';
import {
  TranslationRunDto,
  TranslationRunEstimateDto,
  TranslationRunListItemDto,
} from './dto/translation-run-response.dto';
import {
  DossierEstimateDto,
  DossierStatusDto,
  GlossaryDto,
  TranslationSourceDto,
} from './dto/translation-response.dto';
import { DossierService } from './dossier/dossier.service';
import { TranslationRunService } from './run/translation-run.service';
import { TranslationSourceService } from './translation-source.service';

interface RequestUser {
  userId: string;
}

/**
 * Перевод книги в админке - только `admin` (U6): исходник по D8, досье и глоссарий
 * (`F05-2`), сравнение моделей на главе (`F05-3`), оценка, старт и ход запуска перевода и его
 * кнопки (`F05-4`).
 * Построение досье, сравнение и перевод тратят деньги под своей операцией с лимитом; модель
 * зовёт исполнитель фоном, а не ручка.
 */
@ApiTags('admin')
@ApiExtraModels(TranslationCompareListItemDto, TranslationRunListItemDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class TranslationController {
  constructor(
    private readonly sources: TranslationSourceService,
    private readonly dossiers: DossierService,
    private readonly compares: TranslationCompareService,
    private readonly runs: TranslationRunService,
  ) {}

  @Get('versions/:id/translation-source')
  @ApiOperation({
    summary:
      'Translation source of the book by the original language (D8): whether this version can be translated and into which languages',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationSourceDto })
  async translationSource(@Param('id') id: string): Promise<TranslationSourceDto> {
    return (await this.sources.forVersion(id, { withRunsInProgress: true })).source;
  }

  @Get('versions/:id/dossier/estimate')
  @ApiOperation({ summary: 'Upper cost estimate of building the dossier of this version' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: DossierEstimateDto })
  @ApiConflictResponse({
    description:
      'SOURCE_HAS_NO_CHAPTERS; SOURCE_TOO_MANY_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
  })
  estimate(@Param('id') id: string): Promise<DossierEstimateDto> {
    return this.dossiers.estimate(id);
  }

  @Get('versions/:id/dossier')
  @ApiOperation({
    summary: 'Dossier of this version (its translation source, Р5): status, freshness and data',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: DossierStatusDto })
  status(@Param('id') id: string): Promise<DossierStatusDto> {
    return this.dossiers.status(id);
  }

  @Post('versions/:id/dossier')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Build the dossier in the background under its own operation; a stale one is rebuilt as a new generation',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ type: DossierStatusDto })
  @ApiConflictResponse({
    description:
      'DOSSIER_FRESH: a fresh dossier exists; LLM_CEILING_REACHED: the spending ceiling is reached; SOURCE_HAS_NO_CHAPTERS; SOURCE_TOO_MANY_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED; DOSSIER_BUSY: changed concurrently, try again',
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  build(
    @Param('id') id: string,
    @Body() dto: StartDossierDto,
    @Req() req: { user: RequestUser },
  ): Promise<DossierStatusDto> {
    return this.dossiers.build(
      id,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      req.user.userId,
    );
  }

  @Get('dossiers/:id/glossaries/:lang')
  @ApiOperation({ summary: 'Glossary of the dossier for a target language' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'lang', enum: Language })
  @ApiOkResponse({ type: GlossaryDto })
  glossary(
    @Param('id') id: string,
    @Param('lang', LangParamPipe) lang: Language,
  ): Promise<GlossaryDto> {
    return this.dossiers.glossary(id, lang);
  }

  // Литеральный `estimate` - выше любого динамического сегмента после `translation-compare`.
  @Get('versions/:id/translation-compare/estimate')
  @ApiOperation({
    summary:
      'Upper cost estimate of comparing 2-4 models on one chapter: dossier, glossary, split and each model',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationCompareEstimateDto })
  @ApiBadRequestResponse({
    description: 'COMPARE_TARGET_IS_SOURCE; LLM_MODEL_UNKNOWN; 2-4 distinct models',
  })
  @ApiNotFoundResponse({ description: 'Version or chapter not found' })
  @ApiConflictResponse({
    description:
      'The version is not a translation source by D8 (code = its reason, with sourceVersionId); NOT_IN_INTAKE; COMPARE_CHAPTER_EMPTY; SOURCE_HAS_NO_CHAPTERS; SOURCE_TOO_MANY_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_MODELS_UNAVAILABLE' })
  compareEstimate(
    @Param('id') id: string,
    @Query() query: TranslationCompareEstimateQueryDto,
  ): Promise<TranslationCompareEstimateDto> {
    return this.compares.estimate(id, query);
  }

  @Post('versions/:id/translation-compare')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Compare 2-4 models on one chapter in the background under its own operation; no version is created and the glossary is not changed',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ type: TranslationCompareDto })
  @ApiBadRequestResponse({
    description: 'COMPARE_TARGET_IS_SOURCE; LLM_MODEL_UNKNOWN; 2-4 distinct models; limitUsd',
  })
  @ApiNotFoundResponse({ description: 'Version or chapter not found' })
  @ApiConflictResponse({
    description:
      'LLM_CEILING_REACHED: the spending ceiling is reached; the version is not a translation source by D8 (code = its reason, with sourceVersionId); NOT_IN_INTAKE; COMPARE_CHAPTER_EMPTY; SOURCE_HAS_NO_CHAPTERS; SOURCE_TOO_MANY_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
  })
  @ApiServiceUnavailableResponse({
    description: 'LLM_DISABLED: no OpenRouter key; LLM_MODELS_UNAVAILABLE',
  })
  startCompare(
    @Param('id') id: string,
    @Body() dto: StartTranslationCompareDto,
    @Req() req: { user: RequestUser },
  ): Promise<TranslationCompareDto> {
    return this.compares.start(id, dto, req.user.userId);
  }

  @Get('versions/:id/translation-compares')
  @ApiOperation({ summary: 'Model comparisons of this version, newest first' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ schema: paginatedSchema(TranslationCompareListItemDto) })
  listCompares(
    @Param('id') id: string,
    @Query() query: PaginationDto,
  ): Promise<PaginatedResult<TranslationCompareListItemDto>> {
    return this.compares.list(id, query.page ?? 1, query.limit ?? 10);
  }

  @Get('translation-compares/:id')
  @ApiOperation({
    summary:
      'Model comparison: the original chapter and a column per model with its text, cost, tokens, duration and error',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationCompareDto })
  @ApiNotFoundResponse({ description: 'Translation compare not found' })
  getCompare(@Param('id') id: string): Promise<TranslationCompareDto> {
    return this.compares.get(id);
  }

  // Литеральный `estimate` - выше любого динамического сегмента после `translation-runs`.
  @Get('versions/:id/translation-runs/estimate')
  @ApiOperation({
    summary:
      'Upper cost estimate of translating the book into the given languages: per language and total, the dossier and glossaries built first, chapters near the length limit',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationRunEstimateDto })
  @ApiBadRequestResponse({ description: 'LLM_MODEL_UNKNOWN; 1-5 distinct languages' })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({
    description:
      'The version is not a translation source by D8 (code = its reason, with sourceVersionId); TRANSLATION_TARGET_UNAVAILABLE (languages[{language, reason}]); SOURCE_TOO_MANY_CHAPTERS; TRANSLATION_SOURCE_EMPTY: nothing to translate in the chapters; LLM_NO_PRICE; LLM_STAGE_DISABLED',
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_MODELS_UNAVAILABLE' })
  runEstimate(
    @Param('id') id: string,
    @Query() query: TranslationRunEstimateQueryDto,
  ): Promise<TranslationRunEstimateDto> {
    return this.runs.estimate(id, query);
  }

  @Post('versions/:id/translation-runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Start translating the book into the given languages in the background under one run operation; a language with a version or an unfinished run is refused, the whole request with it',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiAcceptedResponse({ type: TranslationRunDto })
  @ApiBadRequestResponse({
    description:
      'TRANSLATION_RUN_LIMIT_TOO_LOW: limitUsd below the dossier and glossaries built first; LLM_MODEL_UNKNOWN; 1-5 distinct languages; limitUsd',
  })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({
    description:
      'The version is not a translation source by D8 (code = its reason, with sourceVersionId); TRANSLATION_TARGET_UNAVAILABLE (languages[{language, reason}]: IS_SOURCE, VERSION_EXISTS, TRANSLATION_IN_PROGRESS, NOT_IN_INTAKE); SOURCE_TOO_MANY_CHAPTERS; TRANSLATION_SOURCE_EMPTY: nothing to translate in the chapters; LLM_NO_PRICE; LLM_STAGE_DISABLED',
  })
  @ApiServiceUnavailableResponse({
    description: 'LLM_DISABLED: no OpenRouter key; LLM_MODELS_UNAVAILABLE',
  })
  startRun(
    @Param('id') id: string,
    @Body() dto: StartTranslationRunDto,
    @Req() req: { user: RequestUser },
  ): Promise<TranslationRunDto> {
    return this.runs.start(id, dto, req.user.userId);
  }

  @Get('books/:bookId/translation-runs')
  @ApiOperation({ summary: 'Translation runs of the book, newest first' })
  @ApiParam({ name: 'bookId', format: 'uuid' })
  @ApiOkResponse({ schema: paginatedSchema(TranslationRunListItemDto) })
  @ApiNotFoundResponse({ description: 'Book not found' })
  listRuns(
    @Param('bookId') bookId: string,
    @Query() query: PaginationDto,
  ): Promise<PaginatedResult<TranslationRunListItemDto>> {
    return this.runs.listForBook(bookId, query.page ?? 1, query.limit ?? 10);
  }

  @Get('translation-runs/:id')
  @ApiOperation({
    summary:
      'Translation run progress by language: stage, chapter N of M, pieces, flags, pause reason; spent and limit in its operation',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationRunDto })
  @ApiNotFoundResponse({ description: 'Translation run not found' })
  getRun(@Param('id') id: string): Promise<TranslationRunDto> {
    return this.runs.get(id);
  }

  @Post('translation-runs/:id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pause a running translation: the step in progress finishes, nothing more starts. Dossier and glossary operations started for it are not paused',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationRunDto })
  @ApiNotFoundResponse({ description: 'Translation run not found' })
  @ApiConflictResponse({ description: 'TRANSLATION_RUN_NOT_PAUSABLE: not running' })
  pauseRun(@Param('id') id: string): Promise<TranslationRunDto> {
    return this.runs.pause(id);
  }

  @Post('translation-runs/:id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resume a paused translation run on every unfinished language, optionally with a new limit and stage models',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationRunDto })
  @ApiBadRequestResponse({
    description:
      'limitUsd below spent + reserved; LLM_MODEL_UNKNOWN; a stage that cannot be changed',
  })
  @ApiNotFoundResponse({ description: 'Translation run not found' })
  @ApiConflictResponse({
    description:
      'LLM_OPERATION_NOT_RESUMABLE: not paused, or paused on DOSSIER_STALE (cancel and start anew); RETRY_IN_PROGRESS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
  })
  @ApiServiceUnavailableResponse({ description: 'LLM_DISABLED: no OpenRouter key' })
  resumeRun(
    @Param('id') id: string,
    @Body() dto: ResumeTranslationRunDto,
  ): Promise<TranslationRunDto> {
    return this.runs.resume(id, dto);
  }

  @Post('translation-runs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a translation run: unfinished languages stop and the run spends nothing more; translated pieces stay. Dossier and glossary operations started for it run on their own limit and are cancelled separately',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationRunDto })
  @ApiNotFoundResponse({ description: 'Translation run not found' })
  @ApiConflictResponse({ description: 'LLM_OPERATION_NOT_CANCELLABLE: already finished' })
  cancelRun(@Param('id') id: string): Promise<TranslationRunDto> {
    return this.runs.cancel(id);
  }
}
