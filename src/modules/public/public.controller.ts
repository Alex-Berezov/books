import { Controller, Get, Param, Query, Headers, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BookService } from '../book/book.service';
import { PagesService } from '../pages/pages.service';
import { CategoryService } from '../category/category.service';
import { TagsService } from '../tags/tags.service';
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
  tagsBySlug(@Param('lang', LangParamPipe) pathLang: PrismaLanguage, @Param('slug') slug: string) {
    return this.tags.versionsByTagLangSlug(pathLang, slug);
  }
}
