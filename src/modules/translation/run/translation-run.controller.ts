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
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  PaginatedResult,
  PaginationInfoDto,
  paginatedSchema,
} from '../../../shared/dto/paginated-response.dto';
import {
  ListTranslationRunsQueryDto,
  ResumeTranslationRunDto,
  StartTranslationRunDto,
  TranslationRunEstimateQueryDto,
} from '../dto/translation-run-request.dto';
import {
  TranslationRunDto,
  TranslationRunEstimateDto,
  TranslationRunListItemDto,
} from '../dto/translation-run-response.dto';
import { TranslationRunReportDto } from '../dto/translation-run-report-response.dto';
import { TranslationRunReportService } from './translation-run-report.service';
import { TranslationRunService } from './translation-run.service';

interface RequestUser {
  userId: string;
}

/**
 * Запуск перевода (`F05-4`) в админке - только `admin` (U6): оценка, старт, список, ход,
 * отчёт и кнопки «пауза», «продолжить», «отменить». Перевод тратит деньги под операцией
 * запуска с лимитом; модель зовёт исполнитель фоном, а не ручка.
 */
@ApiTags('admin')
@ApiExtraModels(TranslationRunListItemDto, PaginationInfoDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class TranslationRunController {
  constructor(
    private readonly runs: TranslationRunService,
    private readonly reports: TranslationRunReportService,
  ) {}

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
      'The version is not a translation source by D8 (code = its reason, with sourceVersionId); TRANSLATION_TARGET_UNAVAILABLE (languages[{language, reason}]); SOURCE_TOO_MANY_CHAPTERS; TRANSLATION_SOURCE_EMPTY: nothing to translate in the chapters; LLM_NO_PRICE; LLM_STAGE_DISABLED (also of check_semantic, metadata); CHECK_MODEL_SAME_FAMILY: no meaning check model of another family than the translate model',
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
      'The version is not a translation source by D8 (code = its reason, with sourceVersionId); TRANSLATION_TARGET_UNAVAILABLE (languages[{language, reason}]: IS_SOURCE, VERSION_EXISTS, TRANSLATION_IN_PROGRESS, NOT_IN_INTAKE); SOURCE_TOO_MANY_CHAPTERS; TRANSLATION_SOURCE_EMPTY: nothing to translate in the chapters; LLM_NO_PRICE; LLM_STAGE_DISABLED (also of check_semantic, final_check, metadata); CHECK_MODEL_SAME_FAMILY: no meaning check or final check model of another family than the translate model',
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
    @Query() query: ListTranslationRunsQueryDto,
  ): Promise<PaginatedResult<TranslationRunListItemDto>> {
    return this.runs.listForBook(bookId, query.page ?? 1, query.limit ?? 10, {
      bookVersionId: query.bookVersionId,
      active: query.active === true,
    });
  }

  @Get('translation-runs/:id/report')
  @ApiOperation({
    summary:
      'Translation run report: by language - pieces, retries, piece and chapter flags with reasons, final check, chapters not in the draft, the draft version; cost by stage and model over every operation of the run',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationRunReportDto })
  @ApiNotFoundResponse({ description: 'Translation run not found' })
  getRunReport(@Param('id') id: string): Promise<TranslationRunReportDto> {
    return this.reports.report(id);
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
      'LLM_OPERATION_NOT_RESUMABLE: not paused, or paused on DOSSIER_STALE (cancel and start anew); RETRY_IN_PROGRESS; LLM_NO_PRICE; LLM_STAGE_DISABLED; CHECK_MODEL_SAME_FAMILY: after the change no meaning check or final check model of another family than the translate model; TRANSLATION_RUN_MODELS_CHANGED: a concurrent resume changed the stage models, retry',
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
