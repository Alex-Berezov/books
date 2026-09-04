import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Headers,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PublicCacheInterceptor } from '../../common/interceptors/public-cache.interceptor';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { BookService } from '../book/book.service';
import { PagesService } from '../pages/pages.service';
import { CategoryService } from '../category/category.service';
import { TagsService } from '../tags/tags.service';
import { AuthorService } from '../author/author.service';
import { Language as PrismaLanguage } from '@prisma/client';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { LanguageResolverGuard } from '../../common/guards/language-resolver.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { NoPublicCache } from '../../common/decorators/no-public-cache.decorator';
import { RelatedBooksQueryDto } from '../book/dto/related-books.dto';
import { BookCardsQueryDto } from '../book/dto/book-cards-query.dto';
import { GeoIpCountryService, GeoRequestHeaders } from '../geo-block/geo-ip-country.service';
import { SlugRedirectQueryDto } from '../slug-redirect/dto/slug-redirect-query.dto';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import {
  SYSTEM_PAGE_KEY_VALUES,
  isSystemPageKey,
} from '../seo/system-pages/system-pages.constants';
import {
  PUBLIC_CATEGORIES_DEFAULT_LIMIT,
  PUBLIC_CATEGORIES_MAX_LIMIT,
  PublicCategoriesQueryDto,
} from './dto/public-categories-query.dto';
import { PublicAuthorLettersQueryDto, PublicAuthorsQueryDto } from './dto/public-authors-query.dto';
import { PublicTagBooksQueryDto } from './dto/public-tag-books-query.dto';
import { PublicTagsQueryDto } from './dto/public-tags-query.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';

// Helper to validate and coerce path lang to enum
@ApiTags('public-i18n')
@UseGuards(LanguageResolverGuard)
@UseInterceptors(PublicCacheInterceptor)
@Controller(':lang')
export class PublicController {
  constructor(
    private readonly books: BookService,
    private readonly pages: PagesService,
    private readonly categories: CategoryService,
    private readonly tags: TagsService,
    private readonly authors: AuthorService,
    private readonly geoIpCountryService: GeoIpCountryService,
    private readonly slugRedirects: SlugRedirectService,
  ) {}

  /**
   * Куда вёл адрес, которого больше нет (LEGACY-062).
   *
   * Спрашивается фронтом **только при 404**: живая сущность всегда важнее записи в
   * истории, иначе слаг, занятый заново, увёл бы посетителя со страницы, которая
   * существует. Ответ `{ newSlug: null }`, а не 404, — чтобы отсутствие редиректа не
   * пришлось отличать от отказа сети.
   */
  @Get('slug-redirect')
  @ApiOperation({ summary: 'Resolve a retired slug to its current one' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  async slugRedirect(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query() query: SlugRedirectQueryDto,
  ): Promise<{ newSlug: string | null }> {
    const newSlug = await this.slugRedirects.resolve(query.entityType, pathLang, query.slug);
    return { newSlug };
  }

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
  findAll(@Param('lang', LangParamPipe) pathLang: PrismaLanguage, @Query() query: PaginationDto) {
    // Публичная витрина видит только опубликованное (`LEGACY-093`). Раньше
    // фильтра не было ни здесь, ни в сервисе, и правило «только published»
    // существовало **тремя копиями на клиенте**: в каталоге, в карте сайта и в
    // мапперах карточек. Сервер его не соблюдал — каждый потребитель
    // договаривался сам.
    //
    // 🔴 `page`/`limit` раньше принимались голым `@Query('page') page?: number` и
    // шли в сервис через идиому `page ? Number(page) : N`, которая не отличает `0`
    // от отсутствия значения и молча подставляет дефолт на любой мусор (`LEGACY-298`).
    //
    // `PaginationDto` — тот же класс, что уже стоит на административном зеркале
    // (`GET /books`, `book.controller.ts`), а не отдельная копия: дефолты (`page=1`,
    // `limit=10`) и потолок совпадают дословно, и заводить своё DTO ради этого было
    // бы четвёртой копией того же класса, который закрывала `LEGACY-353` (найдено
    // ревью архитектуры).
    return this.books.findAll({ page: query.page, limit: query.limit }, { publishedOnly: true });
  }

  // Related books (compact BookCard) for a book page: same-author + similar-by-category
  @Get('books/:slug/related')
  @ApiOperation({ summary: 'Related books (compact cards) for a book page' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum total number of unique cards (sameAuthor + similar). Default 8, max 16.',
  })
  related(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query() query: RelatedBooksQueryDto,
  ) {
    return this.books.findRelated(slug, pathLang, query.limit);
  }

  // Compact paginated book cards (homepage / catalog) — replaces legacy /books?limit=100
  @Get('books/cards')
  @ApiOperation({ summary: 'Compact paginated book cards for a language (homepage/catalog)' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiQuery({ name: 'page', required: false, description: 'Page number. Default 1.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Cards per page. Default 24, max 48.' })
  @ApiQuery({ name: 'sort', required: false, description: 'Sort order: popular, new.' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by type: audio, text.' })
  @ApiQuery({ name: 'q', required: false, description: 'Search query by title/author.' })
  bookCards(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query() query: BookCardsQueryDto,
  ) {
    return this.books.findCards(pathLang, query.page, query.limit, query.sort, query.type, query.q);
  }

  /**
   * Читалка открыта анониму, но прогресс чтения принадлежит владельцу токена.
   *
   * 🔴 До 10.08.2026 читатель приходил параметром `?userId=`, то есть любой
   * желающий подставлял чужой идентификатор и получал, какую книгу человек
   * читает и на каком месте остановился (`LEGACY-088`). Идентификаторы брались
   * из соседней утечки: `GET /comments` отдавал `user.id` каждого комментатора.
   *
   * ⚠️ `@NoPublicCache()` — не украшение: без query-параметра URL стал общим
   * для всех, и `public, s-maxage=300` начал бы раздавать прогресс первого
   * читателя всем остальным. Снятие кэша и перенос в токен — одна правка,
   * порознь они делают хуже.
   */
  @Get('books/:slug/reader-bootstrap')
  @ApiBearerAuth()
  @UseGuards(OptionalJwtAuthGuard)
  @NoPublicCache()
  @ApiOperation({
    summary: 'Get reader bootstrap info in a single query',
    description:
      'Reading progress is returned only for the bearer of the token. Anonymous callers get the book without the personal part.',
  })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  getReaderBootstrap(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Req() req?: { user?: { userId?: string } },
    @Headers() headers?: GeoRequestHeaders,
  ) {
    return this.books.getReaderBootstrap(
      slug,
      pathLang,
      req?.user?.userId,
      this.geoIpCountryService.resolveCountry(headers ?? {}),
    );
  }

  /**
   * The five pages the site looks up for itself, addressed by a key an editor
   * cannot change (A2, `tasks/system-pages-slug/TASK.md`).
   *
   * ⚠️ Must stay **above** `pages/:slug`: the two patterns differ in segment
   * count today, so Nest separates them, but a future one-segment alias would
   * make `by-key` look like a slug and this route would go dark.
   */
  @Get('pages/by-key/:systemKey')
  @ApiOperation({ summary: 'Public CMS page by immutable system key' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'systemKey', enum: SYSTEM_PAGE_KEY_VALUES })
  getPageByKey(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('systemKey') systemKey: string,
  ) {
    // Закрытый список, а не свободный параметр: иначе маршрут превращается в
    // способ перебирать страницы по колонке, которой нет ни в одном DTO.
    if (!isSystemPageKey(systemKey)) {
      throw new NotFoundException('Unknown system page key');
    }
    return this.pages.getPublicBySystemKey(systemKey, pathLang);
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

  // Compact paginated book cards for a category (or genre/collection)
  @Get('categories/:slug/books/cards')
  @ApiOperation({ summary: 'Compact paginated book cards for a category/genre/collection' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug', description: 'Category/Genre/Collection slug' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number. Default 1.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Cards per page. Default 24, max 48.' })
  categoryBookCards(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query() query: BookCardsQueryDto,
  ) {
    return this.books.findCardsByCategory(slug, pathLang, query.page, query.limit);
  }

  // Public category/genre listing with translations and book counts
  @Get('categories')
  @ApiOperation({ summary: 'Public category/genre listing for catalog sidebar' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  categoriesList(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query() query: PublicCategoriesQueryDto,
  ) {
    // Потолок зажимается **здесь**, а не в сервисе: сервис общий с админским
    // маршрутом, на котором sitemap ходит с `limit=1000`, и потолок там означал бы
    // молчаливое усечение карты сайта (LEGACY-056).
    //
    // В сервис уходит уже зажатое значение — тогда `meta.limit` собирается из
    // применённого, а не из запрошенного. Разница не косметическая: потребитель
    // делит `total` на `meta.limit`, и при молчаливом урезании получает неверное
    // число страниц, не узнав об этом.
    const limit = Math.min(
      query.limit ?? PUBLIC_CATEGORIES_DEFAULT_LIMIT,
      PUBLIC_CATEGORIES_MAX_LIMIT,
    );

    return this.categories.list(query.page ?? 1, limit, query.type, pathLang);
  }

  // Localized tags by translation slug
  @Get('tags/:slug/books')
  @ApiOperation({ summary: 'Public list of book versions by localized tag' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug' })
  tagsBySlug(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query() query: PublicTagBooksQueryDto,
  ) {
    // 🔴 `page` и `limit` принимались голым `@Query('page') page?: number` и уходили
    // в сервис сырыми. Глобальный `ValidationPipe` приводит примитив через `+value`,
    // поэтому `?page=abc` давал `NaN`, `?page=` — `0`, и оба уезжали в `skip`: маршрут
    // отвечал 500 на мусор в адресной строке (`LEGACY-199`). Значение по умолчанию
    // в сигнатуре сервиса от этого не спасает — оно срабатывает только на `undefined`,
    // а `NaN` для `tsc` такой же `number`, как и всякий другой.
    return this.tags.versionsByTagLangSlug(pathLang, slug, query.page, query.limit);
  }

  // Public tags listing for homepage
  @Get('tags')
  @ApiOperation({ summary: 'Public tags listing for homepage' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  tagsList(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query() query: PublicTagsQueryDto,
  ) {
    // 🔴 `page`/`limit` раньше принимались голым `@Query('page') page?: number` и шли
    // в сервис через идиому `page ? Number(page) : N`, которая не отличает `0` от
    // отсутствия значения и молча подставляет дефолт на любой мусор (`LEGACY-298`).
    return this.tags.list(query.page, query.limit, undefined, pathLang);
  }

  // Compact paginated book cards for a tag
  @Get('tags/:slug/books/cards')
  @ApiOperation({ summary: 'Compact paginated book cards for a tag' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug', description: 'Tag slug' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number. Default 1.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Cards per page. Default 24, max 48.' })
  @ApiQuery({
    name: 'includeTag',
    required: false,
    description: 'Include tag details. Default false.',
  })
  tagBookCards(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query() query: BookCardsQueryDto,
  ) {
    return this.books.findCardsByTag(slug, pathLang, query.page, query.limit, query.includeTag);
  }

  // Localized authors list
  @Get('authors')
  @ApiOperation({ summary: 'Public authors list with language prefix' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  authorsList(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query() query: PublicAuthorsQueryDto,
  ) {
    // 🔴 Язык пути не передавался в сервис вовсе (`_pathLang`), поэтому список на
    // любом языке отдавал английские слаг и имя, а счётчик книг не фильтровался
    // по языку. Фронт это обходил, доставая нужный перевод из вложенного
    // `translations`, — обход работал, но означал, что верхнеуровневые поля
    // ответа врут на четырёх языках из пяти.
    //
    // ⚠️ `listPublic`, а не `list`: у списка три читателя, и ни одному из них
    // не нужны биография, цитаты, FAQ и `Seo` каждого перевода, которые `list`
    // отдаёт анониму до сих пор (`LEGACY-214`). `list` остался за админкой.
    return this.authors.listPublic(pathLang, query);
  }

  /**
   * Счётчики алфавитного указателя авторов.
   *
   * ⚠️ Обязана стоять **выше** `authors/:slug`: Nest сопоставляет маршруты в порядке
   * объявления, и ручка, заведённая ниже, была бы съедена как `slug = 'letters'` —
   * ровно тот же порядок, что уже выписан у `pages/by-key/:systemKey`.
   */
  @Get('authors/letters')
  @ApiOperation({ summary: 'Author alphabet index with per-letter counts' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Same name filter as the list. The index sits above the filtered grid, so its counts must describe that grid and not the whole alphabet.',
  })
  authorLetters(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Query() query: PublicAuthorLettersQueryDto,
  ) {
    return this.authors.listPublicLetters(pathLang, query.search);
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

  // Compact paginated book cards for an author (author page fallback) — filters by stable authorId
  @Get('authors/:slug/books/cards')
  @ApiOperation({ summary: 'Compact paginated book cards for an author (author page fallback)' })
  @ApiParam({ name: 'lang', description: 'Path language', enum: PrismaLanguage })
  @ApiParam({ name: 'slug', description: 'Author slug (resolved to stable authorId)' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number. Default 1.' })
  @ApiQuery({ name: 'limit', required: false, description: 'Cards per page. Default 24, max 48.' })
  authorBookCards(
    @Param('lang', LangParamPipe) pathLang: PrismaLanguage,
    @Param('slug') slug: string,
    @Query() query: BookCardsQueryDto,
  ) {
    return this.books.findCardsByAuthor(slug, pathLang, query.page, query.limit);
  }
}
