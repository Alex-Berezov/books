import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  UseGuards,
  UseInterceptors,
  Headers,
  Req,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { BookService } from './book.service';
import { UpdateBookDto } from './dto/update-book.dto';
import { RateBookDto } from './dto/rate-book.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { SLUG_PATTERN } from '../../shared/validators/slug';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { NoPublicCache } from '../../common/decorators/no-public-cache.decorator';
import { PublicCacheInterceptor } from '../../common/interceptors/public-cache.interceptor';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { CheckBookSlugQueryDto } from './dto/check-slug-query.dto';
import { CheckBookSlugResponseDto } from './dto/check-slug-response.dto';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('books')
@Controller('books')
export class BookController {
  private readonly logger = new Logger(BookController.name);

  constructor(private readonly bookService: BookService) {}

  // ⚠️ CRITICAL: check-slug must be the FIRST GET route
  // otherwise dynamic routes (`:slug/overview`) may consume it
  @Get('check-slug')
  @ApiOperation({
    summary: 'Check slug uniqueness for a book',
    description:
      'Quick availability check for a slug. Returns info about an existing book and suggests a unique option if the slug is taken.',
  })
  @ApiResponse({
    status: 200,
    description: 'Slug check result',
    type: CheckBookSlugResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid slug format',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query() query: CheckBookSlugQueryDto): Promise<CheckBookSlugResponseDto> {
    try {
      const existingBook = await this.bookService.checkSlugExists(query.slug, query.excludeId);

      if (!existingBook) {
        // Slug is available
        return {
          exists: false,
        };
      }

      // Slug is taken - generate suggestion
      const suggestedSlug = await this.bookService.generateUniqueSuggestedSlug(query.slug);

      return {
        exists: true,
        suggestedSlug,
        existingBook: {
          id: existingBook.id,
          slug: existingBook.slug,
        },
      };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to check slug', err);
    }
  }

  @Post()
  @ApiOperation({ summary: 'Create new book (DISABLED - use rights intake workflow)' })
  @ApiResponse({ status: 400, description: 'Books must be created from an approved rights intake' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create() {
    throw new HttpException(
      {
        message: 'Books must be created from an approved rights intake',
        details: 'Use POST /admin/rights/intakes/:id/create-book endpoint instead',
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Подсказки тем для админской формы — не публичные данные (LEGACY-065).
   *
   * `getAllThemes()` читает `themes` у **всех** версий без фильтра по статусу, то есть
   * анонимный запрос возвращал в том числе темы неопубликованных черновиков. Фильтр
   * здесь был бы неверным лечением: админской форме подсказки из черновиков как раз
   * нужны — лечится доступом, а не выдачей.
   *
   * Закрыто первым из всего списка открытых GET-маршрутов потому, что переносить
   * нечего: единственный потребитель (`books-front/api/endpoints/admin/books.ts`
   * → `getThemes`) уже ходит через `httpGetAuth` с токеном, а e2e-спек на анонимный
   * доступ к маршруту нет.
   */
  @Get('themes')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({
    summary: 'Get list of all unique themes',
    description: 'Returns a list of all unique themes used in book versions. Admin only.',
  })
  @ApiResponse({ status: 200, description: 'List of themes returned' })
  async getThemes() {
    try {
      return await this.bookService.getAllThemes();
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to retrieve themes list', err);
    }
  }

  @Get(':slug/overview')
  @ApiOperation({
    summary: 'Get book overview by slug',
    description:
      'Aggregated overview of a book: available languages, presence of text/audio/summary, version IDs, and an SEO bundle. Only published versions are shown publicly.',
  })
  @ApiParam({ name: 'slug', description: 'Unique book slug' })
  @ApiQuery({ name: 'lang', required: false, description: 'Requested language (en|es|fr|pt)' })
  @ApiResponse({ status: 200, description: 'Overview returned' })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description: 'RFC 7231 header, e.g. en-US,en;q=0.9,es;q=0.8',
  })
  @ApiResponse({ status: 404, description: 'Book not found' })
  async overview(
    @Param('slug') slug: string,
    @Query('lang') lang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    try {
      return await this.bookService.getOverview(slug, lang, acceptLanguage);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to get book overview', err);
    }
  }

  /**
   * Административный список книг: показывает **все** статусы, включая черновики
   * (`LEGACY-093`).
   *
   * 🔴 Гвард появился только 10.08.2026, и до того маршрут был открыт. Его
   * нельзя было закрыть раньше, потому что на нём сидели ещё двое:
   * публичный каталог (`CatalogTemplate`) и проба `scripts/health_check.sh`.
   * Оба переведены на публичный `GET /:lang/books` — гвард поставлен **после**
   * этого, а не одновременно.
   *
   * ⚠️ Публичной витрине сюда ходить незачем: `GET /:lang/books` отдаёт то же
   * самое, но только опубликованное.
   */
  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get all books with pagination (admin: includes drafts)' })
  @ApiResponse({ status: 200, description: 'Books list successfully retrieved' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findAll(@Query() paginationDto: PaginationDto) {
    try {
      return await this.bookService.findAll(paginationDto);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to retrieve books list', err);
    }
  }

  /**
   * Токен необязателен, но меняет ответ: черновые версии видит только модератор
   * (`LEGACY-090`). `@NoPublicCache` обязателен по той же причине — ответ
   * зависит от того, кто спрашивает, и общему кэшу его раздавать нельзя.
   */
  @Get('slug/:slug')
  @ApiBearerAuth()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(PublicCacheInterceptor)
  @NoPublicCache()
  @ApiOperation({ summary: 'Get book by slug (drafts are visible to moderators only)' })
  @ApiParam({
    name: 'slug',
    description: 'Unique book slug',
    schema: { type: 'string', pattern: SLUG_PATTERN },
    example: 'harry-potter',
  })
  @ApiResponse({ status: 200, description: 'Book found' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findBySlug(@Param('slug') slug: string, @Req() req?: { user?: RequestUser }) {
    try {
      return await this.bookService.findBySlug(slug, req?.user);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to get book by slug', err);
    }
  }

  /** Как и `slug/:slug`: черновики — только держателю токена модератора. */
  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(PublicCacheInterceptor)
  @NoPublicCache()
  @ApiOperation({ summary: 'Get book by ID (drafts are visible to moderators only)' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book found' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findOne(@Param('id') id: string, @Req() req?: { user?: RequestUser }) {
    try {
      return await this.bookService.findOne(id, req?.user);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to get book', err);
    }
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book successfully updated' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async update(@Param('id') id: string, @Body() updateBookDto: UpdateBookDto) {
    try {
      return await this.bookService.update(id, updateBookDto);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to update book', err);
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book successfully deleted' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async remove(@Param('id') id: string) {
    try {
      await this.bookService.remove(id);
      return { success: true };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to delete book', err);
    }
  }

  @Post(':id/rate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rate a book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book successfully rated' })
  @ApiResponse({ status: 400, description: 'Invalid rating score' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async rate(
    @Param('id') bookId: string,
    @Req() req: { user: RequestUser },
    @Body() dto: RateBookDto,
  ) {
    try {
      return await this.bookService.rateBook(req.user.userId, bookId, dto.score);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to rate book', err);
    }
  }

  @Get(':id/my-rating')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current user rating for a book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'User rating score (1-5 or null)' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getMyRating(
    @Param('id') bookId: string,
    @Req() req: { user: RequestUser },
  ): Promise<{ score: number | null }> {
    try {
      return await this.bookService.getUserRating(req.user.userId, bookId);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw this.internalFailure('Failed to get user rating', err);
    }
  }

  /**
   * Ответ на неожиданную ошибку (`LEGACY-114`).
   *
   * 🔴 Текст исключения наружу не уходит. Для Prisma это сообщение драйвера
   * с именем модели, именем колонки, текстом ограничения и иногда фрагментом
   * запроса, а часть маршрутов этого контроллера публична: `GET /books/slug/:slug`
   * и `GET /books/:slug/overview` отвечают анониму. Раньше он лежал в поле
   * `details` рядом с `message`, и ни один механизм его не резал —
   * `SentryExceptionFilter` маскирует тело **запроса**, а тело ответа не трогает
   * вовсе.
   *
   * ⚠️ Диагностика не теряется в двух местах сразу, и оба обязательны. В лог
   * идут текст и стек. В `cause` идёт само исходное исключение: без него
   * `Sentry.captureException` получает только фразу-заглушку со стеком этого
   * метода, и десять разных отказов выглядят в Sentry одинаково.
   *
   * ⚠️ Статус и поле `message` не меняются — их разбирает фронт.
   */
  private internalFailure(message: string, err: unknown): HttpException {
    // Отказ не-`Error` объектом (например, `Promise.reject({ code: 'P2024' })`)
    // иначе превращается в `[object Object]` и не оставляет ничего нигде.
    const cause = err instanceof Error ? err : new Error(BookController.describeCause(err));
    this.logger.error(`${message}: ${cause.message}`, cause.stack);
    return new HttpException({ message }, HttpStatus.INTERNAL_SERVER_ERROR, { cause });
  }

  private static describeCause(err: unknown): string {
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      // Циклическая ссылка в отброшенном объекте.
      return String(err);
    }
  }
}
