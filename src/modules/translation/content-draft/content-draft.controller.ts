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
import { ContentDraftKind, Prisma } from '@prisma/client';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  ContentDraftDto,
  ContentDraftEstimateDto,
  ContentDraftStateDto,
} from '../dto/content-draft-response.dto';
import { StartContentDraftDto } from '../dto/content-draft-request.dto';
import { CONTENT_DRAFT_KINDS } from './content-draft.constants';
import { ContentDraftService } from './content-draft.service';

interface RequestUser {
  userId: string;
}

/** Вид в адресе: три вида Summary и `analysis` (`F05-11`); иной - 400. */
const KIND_PIPE = new ParseEnumPipe(
  Object.fromEntries(CONTENT_DRAFT_KINDS.map((k) => [k, k])) as Record<
    ContentDraftKind,
    ContentDraftKind
  >,
);

const START_CONFLICTS =
  'DRAFT_IN_PROGRESS: a draft of this kind is being built; SUMMARY_SECTIONS_MISSING: no saved section with text (summary_full); SUMMARY_FULL_MISSING: no saved full summary with text (summary_brief); DOSSIER_STALE: the source changed after the dossier, rebuild it; RUN_LANGUAGE_UNFINISHED: the translation run is still writing this version; DRAFT_DOSSIER_MISSING: the run dossier of a translated version is gone; LLM_CEILING_REACHED: the spending ceiling is reached; SOURCE_HAS_NO_CHAPTERS; SOURCE_TOO_MANY_CHAPTERS; LLM_NO_PRICE; LLM_STAGE_DISABLED';

/**
 * Заготовки Summary (`F05-10`) и Analysis (`F05-11`) из досье - только `admin` (U6): оценка,
 * старт фоном под своей операцией, последняя заготовка вида и «не нужна». В пересказ и анализ
 * версии не пишут - черновик сохраняет редактор ручками Summary и Analysis.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class ContentDraftController {
  constructor(private readonly drafts: ContentDraftService) {}

  @Get('versions/:id/drafts/:kind/estimate')
  @ApiOperation({ summary: 'Upper cost estimate of a summary or analysis draft from the dossier' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: CONTENT_DRAFT_KINDS })
  @ApiOkResponse({ type: ContentDraftEstimateDto })
  @ApiNotFoundResponse({ description: 'Book version not found' })
  @ApiConflictResponse({ description: START_CONFLICTS })
  estimate(
    @Param('id') id: string,
    @Param('kind', KIND_PIPE) kind: ContentDraftKind,
  ): Promise<ContentDraftEstimateDto> {
    return this.drafts.estimate(id, kind);
  }

  @Get('versions/:id/drafts/:kind')
  @ApiOperation({
    summary:
      'The latest summary or analysis draft of this kind that is not discarded, in any status (building, ready, failed); null - none',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'kind', enum: CONTENT_DRAFT_KINDS })
  @ApiOkResponse({ type: ContentDraftStateDto })
  latest(
    @Param('id') id: string,
    @Param('kind', KIND_PIPE) kind: ContentDraftKind,
  ): Promise<ContentDraftStateDto> {
    return this.drafts.latest(id, kind);
  }

  @Post('versions/:id/drafts/:kind')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Build a summary or analysis draft in the background under its own operation; the dossier and glossary are built first when missing; the previous ready or failed draft of this kind is discarded',
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
    @Param('kind', KIND_PIPE) kind: ContentDraftKind,
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
      'Discard a draft: a draft being built cancels its operation; the dossier and glossary are not cancelled',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ContentDraftDto })
  @ApiNotFoundResponse({ description: 'Content draft not found' })
  discard(@Param('id') id: string): Promise<ContentDraftDto> {
    return this.drafts.discard(id);
  }

  @Post('content-drafts/:id/sections/:number/added')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark a section of a ready sections draft as added by «Add section»: the card is not offered again; repeating is a no-op',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'number', type: Number })
  @ApiOkResponse({ type: ContentDraftDto })
  @ApiBadRequestResponse({ description: 'DRAFT_SECTION_UNKNOWN: the draft has no such section' })
  @ApiNotFoundResponse({ description: 'Content draft not found' })
  @ApiConflictResponse({ description: 'DRAFT_NOT_READY: not a ready sections draft' })
  markSectionAdded(
    @Param('id') id: string,
    @Param('number', ParseIntPipe) number: number,
  ): Promise<ContentDraftDto> {
    return this.drafts.markSectionAdded(id, number);
  }
}
