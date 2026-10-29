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
import { PaginationDto } from '../../../shared/dto/pagination.dto';
import { PaginatedResult, paginatedSchema } from '../../../shared/dto/paginated-response.dto';
import {
  StartTranslationCompareDto,
  TranslationCompareEstimateQueryDto,
} from '../dto/translation-compare-request.dto';
import {
  TranslationCompareDto,
  TranslationCompareEstimateDto,
  TranslationCompareListItemDto,
} from '../dto/translation-compare-response.dto';
import { TranslationCompareService } from './compare.service';

interface RequestUser {
  userId: string;
}

/**
 * Сравнение моделей на главе (`F05-3`) в админке - только `admin` (U6): оценка, старт фоном
 * под своей операцией с лимитом, список и результат.
 */
@ApiTags('admin')
@ApiExtraModels(TranslationCompareListItemDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class TranslationCompareController {
  constructor(private readonly compares: TranslationCompareService) {}

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
      'The version is not a translation source by D8 (code = its reason, with sourceVersionId); NOT_IN_INTAKE; COMPARE_CHAPTER_EMPTY; SOURCE_HAS_NO_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
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
      'LLM_CEILING_REACHED: the spending ceiling is reached; the version is not a translation source by D8 (code = its reason, with sourceVersionId); NOT_IN_INTAKE; COMPARE_CHAPTER_EMPTY; SOURCE_HAS_NO_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
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
