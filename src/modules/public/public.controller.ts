import { Controller, Get, Param, Query, Headers, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BookService } from '../book/book.service';
import { PagesService } from '../pages/pages.service';
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
  ) {}

  // Localized book overview
  @Get('books/:slug/overview')
  @ApiOperation({ summary: 'Публичный обзор книги с префиксом языка' })
  @ApiParam({ name: 'lang', description: 'Язык пути', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  @ApiQuery({
    name: 'lang',
    required: false,
    description: 'Опциональный query lang (игнорируется, если задан язык пути)',
  })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: 'RFC 7231 header. При наличии языка в пути — имеет меньший приоритет.',
  })
  overview(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query('lang') _queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    // Язык из пути имеет наивысший приоритет
    // Также доступен reqLanguage, если нужно (резолв из guard)
    return this.books.getOverview(slug, pathLang, acceptLanguage);
  }

  // Localized page by slug
  @Get('pages/:slug')
  @ApiOperation({ summary: 'Публичная CMS-страница с префиксом языка' })
  @ApiParam({ name: 'lang', description: 'Язык пути', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  getPage(@Param('lang', LangParamPipe) pathLang: PrismaLanguage, @Param('slug') slug: string) {
    return this.pages.getPublicBySlug(slug, pathLang);
  }
}
