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
  DossierEstimateDto,
  DossierStatusDto,
  GlossaryDto,
  TranslationSourceDto,
} from './dto/translation-response.dto';
import { DossierService } from './dossier/dossier.service';
import { TranslationSourceService } from './translation-source.service';

interface RequestUser {
  userId: string;
}

/**
 * Перевод книги в админке - только `admin` (U6): исходник по D8, досье и глоссарий
 * (`F05-2`), сравнение моделей на главе (`F05-3`). Построение досье и сравнение тратят деньги
 * под своей операцией с лимитом; модель зовёт исполнитель фоном, а не ручка.
 */
@ApiTags('admin')
@ApiExtraModels(TranslationCompareListItemDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class TranslationController {
  constructor(
    private readonly sources: TranslationSourceService,
    private readonly dossiers: DossierService,
    private readonly compares: TranslationCompareService,
  ) {}

  @Get('versions/:id/translation-source')
  @ApiOperation({
    summary:
      'Translation source of the book by the original language (D8): whether this version can be translated and into which languages',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: TranslationSourceDto })
  async translationSource(@Param('id') id: string): Promise<TranslationSourceDto> {
    return (await this.sources.forVersion(id)).source;
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
}
