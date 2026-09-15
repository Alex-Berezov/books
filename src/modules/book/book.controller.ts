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
  Query,
  UseGuards,
  UseInterceptors,
  Req,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiParam,
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
import { BookDetailResponseDto } from './dto/book-detail-response.dto';
import { DeleteBookResponseDto } from './dto/delete-book-response.dto';
import { BookEntityDto } from './dto/book-entity.dto';
import { BookRatingDto, BookRatingScoreDto } from './dto/book-rating.dto';
import { BookListItemDto } from './dto/paged-books.dto';
import {
  PaginationInfoDto,
  paginated,
  paginatedSchema,
} from '../../shared/dto/paginated-response.dto';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('books')
@ApiExtraModels(BookListItemDto, PaginationInfoDto)
@Controller('books')
export class BookController {
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
  @ApiOkResponse({ description: 'List of themes returned', type: String, isArray: true })
  async getThemes() {
    return this.bookService.getAllThemes();
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
  @ApiOkResponse({
    description: 'Books list successfully retrieved',
    schema: paginatedSchema(BookListItemDto),
  })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findAll(@Query() paginationDto: PaginationDto) {
    // 🔴 Форму меняет контроллер, а не `BookService.findAll` (`LEGACY-177`).
    // Тот же метод обслуживает публичный `GET /:lang/books`
    // (`public.controller.ts`), чей ответ лежит в edge-кэше Cloudflare: смена
    // формы там потребовала бы сброса кэша на боевом домене и остаётся за
    // владельцем (решение арбитра 13.09.2026). Поэтому `{data, meta}` сервиса
    // сохраняется как есть, а единую обёртку получает только админское зеркало.
    const { data, meta } = await this.bookService.findAll(paginationDto);
    return paginated(data, meta);
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
  @ApiOkResponse({ description: 'Book found', type: BookDetailResponseDto })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findBySlug(@Param('slug') slug: string, @Req() req?: { user?: RequestUser }) {
    return this.bookService.findBySlug(slug, req?.user);
  }

  /** Как и `slug/:slug`: черновики — только держателю токена модератора. */
  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(PublicCacheInterceptor)
  @NoPublicCache()
  @ApiOperation({ summary: 'Get book by ID (drafts are visible to moderators only)' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiOkResponse({ description: 'Book found', type: BookDetailResponseDto })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findOne(@Param('id') id: string, @Req() req?: { user?: RequestUser }) {
    return this.bookService.findOne(id, req?.user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiOkResponse({ description: 'Book successfully updated', type: BookEntityDto })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async update(@Param('id') id: string, @Body() updateBookDto: UpdateBookDto) {
    return this.bookService.update(id, updateBookDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({
    status: 200,
    description: 'Book successfully deleted',
    type: DeleteBookResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async remove(@Param('id') id: string) {
    await this.bookService.remove(id);
    return { success: true };
  }

  @Post(':id/rate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rate a book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiOkResponse({ description: 'Book successfully rated', type: BookRatingDto })
  @ApiResponse({ status: 400, description: 'Invalid rating score' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async rate(
    @Param('id') bookId: string,
    @Req() req: { user: RequestUser },
    @Body() dto: RateBookDto,
  ) {
    return this.bookService.rateBook(req.user.userId, bookId, dto.score);
  }

  @Get(':id/my-rating')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get current user rating for a book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiOkResponse({ description: 'User rating score (1-5 or null)', type: BookRatingScoreDto })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getMyRating(
    @Param('id') bookId: string,
    @Req() req: { user: RequestUser },
  ): Promise<{ score: number | null }> {
    return this.bookService.getUserRating(req.user.userId, bookId);
  }
}
