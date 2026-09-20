import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Headers,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { ChapterService } from './chapter.service';
import { ListChaptersQueryDto } from './dto/list-chapters-query.dto';
import { ChapterResponseDto } from './dto/chapter-response.dto';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { Query } from '@nestjs/common';
import { GeoIpCountryService, GeoRequestHeaders } from '../geo-block/geo-ip-country.service';

/**
 * Форма пользователя запроса — та же, что в остальных контроллерах
 * (`STYLE_GUIDE.md`, раздел «Контроллеры»). Общего `@CurrentUser()` в проекте
 * нет вовсе, и сведение семи копий к одному декоратору — отдельная работа,
 * записанная строкой в теле `LEGACY-015`.
 */
interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('chapters')
@Controller()
export class ChapterController {
  constructor(
    private readonly service: ChapterService,
    private readonly geoIpCountryService: GeoIpCountryService,
  ) {}

  @Get('versions/:bookVersionId/chapters')
  @ApiOperation({
    summary:
      'List chapters by book version (returns all by default; pass page & limit for pagination)',
  })
  @ApiParam({ name: 'bookVersionId' })
  @ApiOkResponse({ type: ChapterResponseDto, isArray: true })
  list(
    @Param('bookVersionId') bookVersionId: string,
    @Query() query: ListChaptersQueryDto,
    @Headers() headers?: GeoRequestHeaders,
  ) {
    return this.service.listByVersion(
      bookVersionId,
      query.page,
      query.limit,
      this.geoIpCountryService.resolveCountry(headers ?? {}),
    );
  }

  @Get('admin/versions/:bookVersionId/chapters')
  @ApiOperation({
    summary: 'Admin: list chapters by book version (any status, including drafts)',
  })
  @ApiParam({ name: 'bookVersionId' })
  @ApiOkResponse({ type: ChapterResponseDto, isArray: true })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listAdmin(@Param('bookVersionId') bookVersionId: string, @Query() query: ListChaptersQueryDto) {
    return this.service.listAdminByVersion(bookVersionId, query.page, query.limit);
  }

  @Post('versions/:bookVersionId/chapters')
  @ApiOperation({ summary: 'Create chapter for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiResponse({ status: 201, description: 'Created', type: ChapterResponseDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Param('bookVersionId') bookVersionId: string, @Body() dto: CreateChapterDto) {
    return this.service.create(bookVersionId, dto);
  }

  @Get('chapters/:id')
  @ApiOperation({ summary: 'Get chapter by id' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: ChapterResponseDto })
  get(@Param('id') id: string, @Headers() headers: GeoRequestHeaders) {
    return this.service.get(id, this.geoIpCountryService.resolveCountry(headers));
  }

  @Patch('chapters/:id')
  @ApiOperation({ summary: 'Update chapter by id' })
  @ApiOkResponse({ type: ChapterResponseDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateChapterDto) {
    return this.service.update(id, dto);
  }

  @Delete('chapters/:id')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete chapter by id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string, @Req() req: { user: RequestUser }) {
    // Актёр берётся из запроса, а не из тела: журнал должен отвечать «кто»,
    // а не «кто представился» (`LEGACY-015`).
    return this.service.remove(id, req.user.userId);
  }
}
