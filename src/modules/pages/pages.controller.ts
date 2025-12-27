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
  Query,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PagesService } from './pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { Language } from '@prisma/client';
import { PageResponse, PaginatedPagesResponse } from './dto/page-response.dto';
import { CheckSlugQueryDto } from './dto/check-slug-query.dto';
import { CheckPageSlugResponseDto } from './dto/check-slug-response.dto';
import { PaginatedPageGroupsResponse } from './dto/page-group-response.dto';

@ApiTags('pages')
@Controller()
export class PagesController {
  constructor(private readonly service: PagesService) {}

  // ⚠️ CRITICAL: check-slug must be FIRST, before ALL other routes
  // otherwise it will conflict with admin/pages/:id (NestJS may treat "check-slug" as a UUID)
  @Get('admin/pages/check-slug')
  @ApiOperation({
    summary: 'Check slug uniqueness for a page',
    description:
      'Quick availability check for a slug. Returns info about an existing page and suggests a unique option if the slug is taken.',
  })
  @ApiQuery({
    name: 'lang',
    enum: Object.values(Language),
    description: 'Page language',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Slug check result',
    type: CheckPageSlugResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid slug format',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query() query: CheckSlugQueryDto): Promise<CheckPageSlugResponseDto> {
    // lang is already validated by class-validator in CheckSlugQueryDto
    const lang = query.lang as Language;

    const existingPage = await this.service.checkSlugExists(query.slug, lang, query.excludeId);

    if (!existingPage) {
      // Slug is available
      return {
        exists: false,
      };
    }

    // Slug is taken - generate suggestion
    const suggestedSlug = await this.service.generateUniqueSuggestedSlug(query.slug, lang);

    return {
      exists: true,
      suggestedSlug,
      existingPage: {
        id: existingPage.id,
        title: existingPage.title,
        status: existingPage.status,
      },
    };
  }

  @Get('admin/pages')
  @ApiOperation({ summary: 'Get all pages grouped by translation group (language agnostic)' })
  @ApiResponse({
    status: 200,
    description: 'List of page groups',
    type: PaginatedPageGroupsResponse,
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async findAllGrouped(@Query() query: PaginationDto) {
    return this.service.adminListGrouped(query.page, query.limit);
  }

  // Public: get page by slug (only published)
  @Get('pages/:slug')
  @ApiOperation({ summary: 'Public page by slug (published only)' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'lang', required: false, description: 'Requested language (en|es|fr|pt)' })
  @ApiHeader({ name: 'Accept-Language', required: false })
  getPublic(
    @Param('slug') slug: string,
    @Query('lang') lang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<any> {
    return this.service.getPublicBySlugWithPolicy(slug, lang, acceptLanguage);
  }

  @Get('admin/pages/:id')
  @ApiOperation({ summary: 'Get page by ID (admin): any status' })
  @ApiParam({ name: 'id', description: 'Page UUID' })
  @ApiResponse({ status: 200, type: PageResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  findById(@Param('id') id: string): Promise<PageResponse> {
    return this.service.findById(id);
  }

  // ⚠️ IMPORTANT: admin/:lang/pages must come AFTER all static admin/pages/* routes
  // otherwise `:lang` may swallow static segments like "check-slug"
  @Get('admin/:lang/pages')
  @ApiOperation({ summary: 'List pages (admin): draft+published' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiHeader({
    name: 'X-Admin-Language',
    required: false,
    description: 'Takes precedence over path language',
  })
  @ApiResponse({ status: 200, type: PaginatedPagesResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  adminList(
    @Param('lang', LangParamPipe) lang: Language,
    @Query() pagination?: PaginationDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ): Promise<PaginatedPagesResponse> {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    const headerLang = (adminLangHeader || '').toLowerCase();
    const effLang = (Object.values(Language) as string[]).includes(headerLang)
      ? (headerLang as Language)
      : lang;
    return this.service.adminList(page, limit, effLang);
  }

  @Post('admin/:lang/pages')
  @ApiOperation({ summary: 'Create page (admin)' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiHeader({
    name: 'X-Admin-Language',
    required: false,
    description: 'Takes precedence over the path language',
  })
  @ApiResponse({ status: 201, type: PageResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(
    @Param('lang', LangParamPipe) lang: Language,
    @Body() dto: CreatePageDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ): Promise<PageResponse> {
    const headerLang = (adminLangHeader || '').toLowerCase();
    const effLang = (Object.values(Language) as string[]).includes(headerLang)
      ? (headerLang as Language)
      : lang;
    return this.service.create(dto, effLang);
  }

  @Patch('admin/:lang/pages/:id')
  @ApiOperation({ summary: 'Update page (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(
    @Param('lang', LangParamPipe) _lang: Language,
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
  ): Promise<any> {
    return this.service.update(id, dto);
  }

  @Delete('admin/:lang/pages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete page (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('lang', LangParamPipe) _lang: Language, @Param('id') id: string): Promise<any> {
    return this.service.remove(id);
  }

  @Patch('admin/:lang/pages/:id/publish')
  @ApiOperation({ summary: 'Publish page' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  publish(@Param('lang', LangParamPipe) _lang: Language, @Param('id') id: string): Promise<any> {
    return this.service.setStatus(id, 'published');
  }

  @Patch('admin/:lang/pages/:id/unpublish')
  @ApiOperation({ summary: 'Unpublish page' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  unpublish(@Param('lang', LangParamPipe) _lang: Language, @Param('id') id: string): Promise<any> {
    return this.service.setStatus(id, 'draft');
  }

  @Get('admin/pages/group/:groupId')
  @ApiOperation({ summary: 'Get all pages in a translation group' })
  @ApiResponse({
    status: 200,
    description: 'List of pages in the group',
    type: [PageResponse],
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async findByGroup(@Param('groupId') groupId: string) {
    return this.service.findByGroupId(groupId);
  }
}
