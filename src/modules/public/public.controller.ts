import { Controller, Get, Param, Query, Headers, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BookService } from '../book/book.service';
import { PagesService } from '../pages/pages.service';
import { CategoryService } from '../category/category.service';
import { TagsService } from '../tags/tags.service';
import { AuthorService } from '../author/author.service';
import { Language as PrismaLanguage } from '@prisma/client';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { LanguageResolverGuard } from '../../common/guards/language-resolver.guard';

// Helper to validate and coerce path lang to enum
@ApiTags('public-i18n')
@UseGuards(LanguageResolverGuard)
@Controller(':lang')
export class PublicController {
  constructor(
    private readonly books: BookService,
    private readonly pages: PagesService,
    private readonly categories: CategoryService,
    private readonly tags: TagsService,
    private readonly authors: AuthorService,
  ) {}

  // Localized book overview
  @Get('books/:slug/overview')
  @ApiOperation({ summary: 'Public book overview with language prefix' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  @ApiQuery({
    name: 'lang',
    required: false,
    description: 'Optional query lang (ignored when a path language is provided)',
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: 'RFC 7231 header. When a path language is present, this has lower priority.',
  })
  overview(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query('lang') _queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    // The language from the path has the highest priority
    // reqLanguage is also available if needed (resolved by guard)
    return this.books.getOverview(slug, pathLang, acceptLanguage);
  }

  // Localized books list
  @Get('books')
  @ApiOperation({ summary: 'Public books list with language prefix' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    // Forward to bookService.findAll (passing the resolved language/pagination params if service supports lang filtering, or just passing page/limit)
    // Note: paginationDto has { page, limit }. Let's build a PaginationDto parameter format.
    return this.books.findAll({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // Localized reader bootstrap endpoint
  @Get('books/:slug/reader-bootstrap')
  @ApiOperation({ summary: 'Get reader bootstrap info in a single query' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'userId', required: false })
  getReaderBootstrap(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query('userId') userId?: string,
  ) {
    return this.books.getReaderBootstrap(slug, pathLang, userId);
  }

  // Localized page by slug
  @Get('pages/:slug')
  @ApiOperation({ summary: 'Public CMS page with language prefix' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  getPage(@Param('lang', LangParamPipe) pathLang: PrismaLanguage, @Param('slug') slug: string) {
    return this.pages.getPublicBySlug(slug, pathLang);
  }

  // Localized categories by translation slug
  @Get('categories/:slug/books')
  @ApiOperation({ summary: 'Public list of book versions by localized category' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  categoriesBySlug(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
  ) {
    return this.categories.getByLangSlugWithBooks(pathLang, slug);
  }

  // Localized tags by translation slug
  @Get('tags/:slug/books')
  @ApiOperation({ summary: 'Public list of book versions by localized tag' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  tagsBySlug(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.tags.versionsByTagLangSlug(pathLang, slug, page, limit);
  }

  // Localized authors list
  @Get('authors')
  @ApiOperation({ summary: 'Public authors list with language prefix' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  authorsList(
    @Param('lang') _pathLang: PrismaLanguage,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.authors.list(page ? Number(page) : 1, limit ? Number(limit) : 50);
  }

  // Localized author details by slug
  @Get('authors/:slug')
  @ApiOperation({ summary: 'Public author details by slug with language prefix' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  authorBySlug(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
  ) {
    return this.authors.getPublicBySlug(slug, pathLang);
  }
}
