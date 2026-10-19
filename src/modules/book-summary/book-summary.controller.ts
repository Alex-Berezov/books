import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
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
import { BookSummaryService } from './book-summary.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';
import { BookSummaryResponseDto } from './dto/book-summary-response.dto';
import { UpdateBookSummaryBriefDto } from './dto/update-book-summary-brief.dto';
import { GeoIpCountryService, GeoRequestHeaders } from '../geo-block/geo-ip-country.service';
import { BookSummarySectionsService } from './book-summary-sections.service';
import { CreateBookSummarySectionDto } from './dto/create-book-summary-section.dto';
import { UpdateBookSummarySectionDto } from './dto/update-book-summary-section.dto';
import { DeleteBookSummarySectionDto } from './dto/delete-book-summary-section.dto';
import { ReorderBookSummarySectionsDto } from './dto/reorder-book-summary-sections.dto';
import {
  BookSummarySectionAdminDto,
  BookSummarySectionCreateResponseDto,
  BookSummarySectionListDto,
  BookSummarySectionPageDto,
  BookSummarySectionUpdateResponseDto,
} from './dto/book-summary-section-response.dto';

@ApiTags('summaries')
@Controller()
export class BookSummaryController {
  constructor(
    private readonly service: BookSummaryService,
    private readonly sections: BookSummarySectionsService,
    private readonly geoIpCountryService: GeoIpCountryService,
  ) {}

  @Get('versions/:bookVersionId/summary')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get book summary for a version (drafts are visible to editors only)',
  })
  // Тело ответа может отсутствовать: `getByVersion` заканчивается `findFirst` и отдаёт `null`,
  // если у версии нет пересказа (`book-summary.service.ts`). `type: BookSummaryResponseDto`
  // обещал бы объект всегда, и клиент по схеме не знал бы про пустую ветку.
  @ApiExtraModels(BookSummaryResponseDto)
  @ApiOkResponse({
    schema: { allOf: [{ $ref: getSchemaPath(BookSummaryResponseDto) }], nullable: true },
    description: 'Summary, or null when the version has none',
  })
  @ApiParam({ name: 'bookVersionId' })
  get(
    @Param('bookVersionId') bookVersionId: string,
    @Req() req?: { user?: { userId: string; email: string } },
  ) {
    return this.service.getByVersion(bookVersionId, req?.user);
  }

  @Put('versions/:bookVersionId/summary')
  @ApiOperation({ summary: 'Create or update summary for a version (upsert)' })
  @ApiOkResponse({ type: BookSummaryResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateBookSummaryDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }

  @Put('versions/:bookVersionId/summary/brief')
  @ApiOperation({
    summary:
      'Set the very short summary of a version (the key is required; null or "" clears it); 409 without a full summary',
  })
  @ApiOkResponse({ type: BookSummaryResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsertBrief(
    @Param('bookVersionId') bookVersionId: string,
    @Body() dto: UpdateBookSummaryBriefDto,
  ): Promise<BookSummaryResponseDto> {
    return this.service.upsertBrief(bookVersionId, dto);
  }

  // Литеральные пути выше параметрических (`route-order.spec.ts`): `…/delete` и `…/order` не
  // должны уйти в соседние ручки по `:sectionId`.
  @Post('versions/:bookVersionId/summary-sections/delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete a summary section and renumber the following ones; 409 when `from` is not the current order',
  })
  @ApiOkResponse({ type: BookSummarySectionListDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  deleteSection(
    @Param('bookVersionId') bookVersionId: string,
    @Body() dto: DeleteBookSummarySectionDto,
  ): Promise<BookSummarySectionListDto> {
    return this.sections.remove(bookVersionId, dto);
  }

  @Put('versions/:bookVersionId/summary-sections/order')
  @ApiOperation({
    summary: 'Reorder summary sections; 409 when `from` is not the current order',
  })
  @ApiOkResponse({ type: BookSummarySectionListDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  reorderSections(
    @Param('bookVersionId') bookVersionId: string,
    @Body() dto: ReorderBookSummarySectionsDto,
  ): Promise<BookSummarySectionListDto> {
    return this.sections.reorder(bookVersionId, dto);
  }

  @Get('versions/:bookVersionId/summary-sections')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Summary sections of a version without texts (editors see all; readers get [] when the full summary has no text or a settled rights claim blocks the version anywhere)',
  })
  @ApiOkResponse({ type: BookSummarySectionListDto })
  @ApiParam({ name: 'bookVersionId' })
  listSections(
    @Param('bookVersionId') bookVersionId: string,
    @Req() req?: { user?: { userId: string; email: string } },
  ): Promise<BookSummarySectionListDto> {
    return this.sections.list(bookVersionId, req?.user);
  }

  @Post('versions/:bookVersionId/summary-sections')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Append a summary section (the service assigns the number)' })
  @ApiOkResponse({ type: BookSummarySectionCreateResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  createSection(
    @Param('bookVersionId') bookVersionId: string,
    @Body() dto: CreateBookSummarySectionDto,
  ): Promise<BookSummarySectionCreateResponseDto> {
    return this.sections.create(bookVersionId, dto);
  }

  @Get('versions/:bookVersionId/summary-sections/:number')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Public summary section page by number (451 under a settled rights claim, checked before existence)',
  })
  @ApiOkResponse({ type: BookSummarySectionPageDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiParam({ name: 'number' })
  getSectionByNumber(
    @Param('bookVersionId') bookVersionId: string,
    @Param('number') number: string,
    @Headers() headers?: GeoRequestHeaders,
    @Req() req?: { user?: { userId: string; email: string } },
  ): Promise<BookSummarySectionPageDto> {
    return this.sections.getByNumber(
      bookVersionId,
      number,
      req?.user,
      this.geoIpCountryService.resolveCountry(headers ?? {}),
    );
  }

  @Get('summary-sections/:sectionId')
  @ApiOperation({ summary: 'Summary section with text by id (admin tab)' })
  @ApiOkResponse({ type: BookSummarySectionAdminDto })
  @ApiParam({ name: 'sectionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  getSectionById(@Param('sectionId') sectionId: string): Promise<BookSummarySectionAdminDto> {
    return this.sections.getById(sectionId);
  }

  @Put('summary-sections/:sectionId')
  @ApiOperation({
    summary: 'Edit a summary section by id; 409 when expectedUpdatedAt is stale',
  })
  @ApiOkResponse({ type: BookSummarySectionUpdateResponseDto })
  @ApiParam({ name: 'sectionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  updateSection(
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateBookSummarySectionDto,
  ): Promise<BookSummarySectionUpdateResponseDto> {
    return this.sections.update(sectionId, dto);
  }
}
