import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Language, Prisma } from '@prisma/client';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { LangParamPipe } from '../../../common/pipes/lang-param.pipe';
import { StartDossierDto } from '../dto/start-dossier.dto';
import {
  DossierEstimateDto,
  DossierStatusDto,
  GlossaryDto,
  TranslationSourceDto,
} from '../dto/translation-response.dto';
import { TranslationSourceService } from '../translation-source.service';
import { DossierService } from './dossier.service';

interface RequestUser {
  userId: string;
}

/**
 * Исходник перевода по D8 и досье с глоссарием (`F05-2`) в админке - только `admin` (U6).
 * Построение досье тратит деньги под своей операцией с лимитом; модель зовёт исполнитель
 * фоном, а не ручка.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class DossierController {
  constructor(
    private readonly sources: TranslationSourceService,
    private readonly dossiers: DossierService,
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
    description: 'SOURCE_HAS_NO_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED',
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
      'DOSSIER_FRESH: a fresh dossier exists; DOSSIER_OF_RUN: the version was made by a translation run, its dossier is the run dossier; LLM_CEILING_REACHED: the spending ceiling is reached; SOURCE_HAS_NO_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED; DOSSIER_BUSY: changed concurrently, try again',
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
}
