import { Body, Controller, Get, Headers, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { GeoIpCountryService, GeoRequestHeaders } from '../geo-block/geo-ip-country.service';
import { BookAnalysisService } from './book-analysis.service';
import { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';
import { SaveBookAnalysisQueryDto } from './dto/save-book-analysis-query.dto';
import {
  BookAnalysisClaimClosuresResponseDto,
  BookAnalysisResponseDto,
  BookAnalysisSaveResponseDto,
} from './dto/book-analysis-response.dto';

@ApiTags('analyses')
@Controller()
export class BookAnalysisController {
  constructor(
    private readonly service: BookAnalysisService,
    private readonly geoIpCountryService: GeoIpCountryService,
  ) {}

  /**
   * Список закрытий анализа блоками окончённых претензий — для middleware фронта (решение арбитра
   * `F03 | F03-2`). Публичный: в нём только слаги, язык, страна и срок; ответ одинаков для всех.
   */
  @Get('analyses/claim-closures')
  @ApiOperation({
    summary:
      'Where book analyses are closed by active blocks of settled rights claims (slugs, language, country, expiry only)',
  })
  @ApiOkResponse({ type: BookAnalysisClaimClosuresResponseDto })
  listClaimClosures() {
    return this.service.listClaimClosures();
  }

  @Get('versions/:bookVersionId/analysis')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get book analysis for a version (drafts and analyses without a core are visible to editors only; closed only by active rights-claim blocks of claims whose dispute is over)',
  })
  // Тело может отсутствовать: у версии нет анализа — `null` (как у пересказа).
  @ApiExtraModels(BookAnalysisResponseDto)
  @ApiOkResponse({
    schema: { allOf: [{ $ref: getSchemaPath(BookAnalysisResponseDto) }], nullable: true },
    description: 'Analysis, or null when the version has none',
  })
  @ApiParam({ name: 'bookVersionId' })
  @UseGuards(OptionalJwtAuthGuard)
  get(
    @Param('bookVersionId') bookVersionId: string,
    @Headers() headers?: GeoRequestHeaders,
    @Req() req?: { user?: { userId: string; email: string } },
  ) {
    return this.service.getByVersion(
      bookVersionId,
      req?.user,
      this.geoIpCountryService.resolveCountry(headers ?? {}),
    );
  }

  @Put('versions/:bookVersionId/analysis')
  @ApiOperation({
    summary:
      'Create or merge analysis for a version (JSON import format); dryRun=true writes nothing',
  })
  @ApiOkResponse({ type: BookAnalysisSaveResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  save(
    @Param('bookVersionId') bookVersionId: string,
    @Query() query: SaveBookAnalysisQueryDto,
    @Body() dto: UpdateBookAnalysisDto,
  ) {
    return this.service.saveForVersion(bookVersionId, dto, query.dryRun === 'true');
  }
}
