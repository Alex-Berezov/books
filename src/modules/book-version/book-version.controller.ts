import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  Headers,
  Req,
} from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';
import {
  BookVersionAdminDetailResponseDto,
  BookVersionResponseDto,
  PublicBookVersionDetailResponseDto,
  PublicBookVersionListItemDto,
} from './dto/book-version-response.dto';
import {
  PublicationGateResultDto,
  UpdateRightsGeoBlockDto,
} from './dto/publication-gate-result.dto';
import { BookRightsDashboardDto } from './dto/rights-dashboard.dto';
import { CreateBookVersionContributorDto } from './dto/create-version-contributor.dto';
import { UpdateBookVersionContributorDto } from './dto/update-version-contributor.dto';
import { ReorderBookVersionContributorsDto } from './dto/reorder-version-contributors.dto';
import { BookVersionContributorResponseDto } from './dto/version-contributor-response.dto';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { RightsContentHashCheckDto } from '../rights-intake/dto/rights-content-hash.dto';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { LicenseCoverageResultDto } from '../rights-licenses/dto/rights-license-response.dto';
import { RightsClaimsService } from '../rights-claims/rights-claims.service';
import { RightsClaimListResponseDto } from '../rights-claims/dto/rights-claim-response.dto';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Language, BookType } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoIpCountryService, GeoRequestHeaders } from '../geo-block/geo-ip-country.service';
import { GeoBlockRulesResponseDto } from '../geo-block/dto/geo-block.dto';
import { NoPublicCache } from '../../common/decorators/no-public-cache.decorator';
import { PublicCacheInterceptor } from '../../common/interceptors/public-cache.interceptor';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('book-versions')
@Controller()
export class BookVersionController {
  constructor(
    private readonly service: BookVersionService,
    private readonly publicationGateService: PublicationGateService,
    private readonly rightsContentHashService: RightsContentHashService,
    private readonly geoIpCountryService: GeoIpCountryService,
    private readonly geoBlockRuleService: GeoBlockRuleService,
    private readonly licenseCoverageService: RightsLicenseCoverageService,
    private readonly rightsClaimsService: RightsClaimsService,
    private readonly moderatorRoles: ModeratorRolesService,
  ) {}

  /**
   * Черновики здесь видит только модератор — по образцу `BookController.findOne`
   * (`book.controller.ts:247` → `book.service.ts:176`, `LEGACY-090`).
   *
   * ⚠️ Не-модератор (в том числе аноним) уходит в публичный `list()` **молча**,
   * без 401/403: адрес публичный и код ответа менять нельзя. Раньше
   * `includeDrafts=true` не проверялся ничем — гвардов на маршруте нет,
   * глобального auth-гварда в приложении тоже, — и `listAdmin` отдавал аноним
   * черновики со всем правовым контуром версии (`include` без `select`).
   *
   * 🔴 `PublicCacheInterceptor` + `@NoPublicCache()` здесь обязательны, и именно
   * потому, что ответ зависит от пользователя. Интерцептор — не источник утечки,
   * а единственный механизм, которым ответ помечается персональным: он ставит
   * `Cache-Control: private, no-store` и `Vary: Authorization`
   * (`public-cache.interceptor.ts`). Без него маршрут не отдаёт ни того, ни
   * другого, а ключом общего кэша остаётся один URL — и админский ответ
   * (`listAdmin`, все 66 полей строки, включая `rightsContentHashInput`)
   * раздаётся анониму, пришедшему по тому же адресу. `private, no-store`
   * не понижается до `s-maxage` ни для одной ветки: одна и та же ручка отвечает
   * и модератору, и анониму, а различить их постфактум уже нечем.
   *
   * Интерцептор вешается на обработчик, а не на класс: остальные маршруты этого
   * контроллера — админские, публичного кэша им не нужно вовсе.
   */
  @Get('books/:bookId/versions')
  @ApiBearerAuth()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(PublicCacheInterceptor)
  @NoPublicCache()
  @ApiOperation({
    summary: 'List versions for a book (public; drafts are visible to moderators only)',
    description:
      'Публичный список версий книги. Возвращает только опубликованные версии (status=published).',
  })
  @ApiParam({ name: 'bookId' })
  @ApiQuery({ name: 'language', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'isFree', required: false, schema: { type: 'boolean' } })
  @ApiHeader({
    name: 'Accept-Language',
    required: false,
    description:
      'RFC 7231 header. Используется только если параметр language не задан: выбирает ближайший доступный язык из опубликованных версий.',
    schema: {
      type: 'string',
      example: 'es-ES,fr;q=0.9,en;q=0.5',
    },
  })
  @ApiQuery({
    name: 'includeDrafts',
    required: false,
    schema: { type: 'boolean' },
    description:
      'Только для админов/контент-менеджеров (требует токена с ролью admin/content_manager). ' +
      'Если true и токен модератора предъявлен — возвращает также черновики; иначе параметр игнорируется.',
  })
  // Настоящий union: не-модератор получает публичный `list()` — белый список полей
  // `PublicBookVersionListItemDto`; модератор с `includeDrafts=true` получает
  // `listAdmin()` — строку версии целиком, вместе с правовым контуром.
  @ApiExtraModels(PublicBookVersionListItemDto, BookVersionResponseDto)
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        oneOf: [
          { $ref: getSchemaPath(PublicBookVersionListItemDto) },
          { $ref: getSchemaPath(BookVersionResponseDto) },
        ],
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'Заголовок Authorization предъявлен, но токен невалиден или истёк. Пустого заголовка ' +
      'OptionalJwtAuthGuard не требует: без него запрос идёт как анонимный и отвечает 200.',
  })
  async list(
    @Param('bookId') bookId: string,
    @Query('language') language?: string,
    @Query('type') type?: string,
    @Query('isFree') isFree?: string,
    @Query('includeDrafts') includeDrafts?: string,
    @Headers('accept-language') acceptLanguage?: string,
    @Req() req?: { user?: RequestUser },
  ) {
    const langEnum =
      language && Object.values(Language).includes(language as Language)
        ? (language as Language)
        : undefined;
    const typeEnum =
      type && Object.values(BookType).includes(type as BookType) ? (type as BookType) : undefined;
    // Если includeDrafts=true и пользователь модератор — используем admin-листинг
    if (includeDrafts === 'true' && (await this.moderatorRoles.isModerator(req?.user))) {
      return this.service.listAdmin(bookId, {
        language: langEnum,
        type: typeEnum,
        isFree: isFree !== undefined ? isFree === 'true' : undefined,
      });
    }
    return this.service.list(
      bookId,
      {
        language: langEnum,
        type: typeEnum,
        isFree: isFree !== undefined ? isFree === 'true' : undefined,
      },
      acceptLanguage,
    );
  }

  @Post('books/:bookId/versions')
  @ApiOperation({
    summary: 'Create book version',
    description:
      'Создаёт версию книги в статусе draft. Опубликовать можно через PATCH /versions/:id/publish.',
  })
  @ApiParam({ name: 'bookId' })
  @ApiBody({
    type: CreateBookVersionDto,
    examples: {
      text: {
        summary: 'Text version (draft by default)',
        value: {
          language: 'en',
          title: "Harry Potter and the Philosopher's Stone",
          author: 'J.K. Rowling',
          description: 'First book of the series',
          coverImageUrl: 'https://cdn.example.com/covers/hp1.jpg',
          type: 'text',
          isFree: true,
          referralUrl: 'https://amazon.com/ref123',
          seoMetaTitle: 'Harry Potter — Summary',
          seoMetaDescription: 'Overview, themes and details about the book',
        },
      },
      audio: {
        summary: 'Audio version',
        value: {
          language: 'en',
          title: 'Harry Potter — Audiobook',
          author: 'J.K. Rowling',
          description: 'Narrated audiobook version',
          coverImageUrl: 'https://cdn.example.com/covers/hp1-audio.jpg',
          type: 'audio',
          isFree: false,
          seoMetaTitle: 'HP1 Audio',
          seoMetaDescription: 'Listen to the audiobook version',
        },
      },
      referral: {
        summary: 'Referral version (external link)',
        value: {
          language: 'en',
          title: 'Harry Potter — Buy Now',
          author: 'J.K. Rowling',
          description: 'Referral to external store',
          coverImageUrl: 'https://cdn.example.com/covers/hp1-ref.jpg',
          type: 'referral',
          isFree: false,
          referralUrl: 'https://store.example.com/hp1',
          seoMetaTitle: 'HP1 Referral',
          seoMetaDescription: 'Purchase the book externally',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Created',
    type: BookVersionResponseDto,
    examples: {
      created: {
        summary: 'Created draft version',
        value: {
          id: '0c1c1e5a-1111-2222-3333-444444444444',
          bookId: 'a1111111-b222-4c33-d444-555555555555',
          language: 'en',
          title: "Harry Potter and the Philosopher's Stone",
          author: 'J.K. Rowling',
          description: 'First book of the series',
          coverImageUrl: 'https://cdn.example.com/covers/hp1.jpg',
          type: 'text',
          isFree: true,
          referralUrl: 'https://amazon.com/ref123',
          status: 'draft',
          publishedAt: null,
          createdAt: '2025-08-25T12:00:00.000Z',
          updatedAt: '2025-08-25T12:00:00.000Z',
          seo: {
            metaTitle: 'Harry Potter — Summary',
            metaDescription: 'Overview, themes and details about the book',
          },
        },
      },
    },
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Param('bookId') bookId: string, @Body() dto: CreateBookVersionDto) {
    return this.service.create(bookId, dto);
  }

  @Post('admin/:lang/books/:bookId/versions')
  @ApiOperation({ summary: 'Admin: create book version in selected admin language' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiParam({ name: 'bookId' })
  @ApiBody({ type: CreateBookVersionDto })
  @ApiHeader({ name: 'X-Admin-Language', required: false, description: 'Приоритетнее языка пути' })
  @ApiCreatedResponse({ type: BookVersionResponseDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  createAdmin(
    @Param('lang', LangParamPipe) lang: Language,
    @Param('bookId') bookId: string,
    @Body() dto: CreateBookVersionDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ) {
    // Игнорируем dto.language — язык берётся из контекста админки
    const headerLang = (adminLangHeader || '').toLowerCase();
    const effLang = (Object.values(Language) as string[]).includes(headerLang)
      ? (headerLang as Language)
      : lang;
    return this.service.create(bookId, dto, effLang);
  }

  @Get('admin/:lang/books/:bookId/versions')
  @ApiOperation({ summary: 'Admin: list versions for a book (includes drafts)' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiParam({ name: 'bookId' })
  @ApiOkResponse({ type: BookVersionResponseDto, isArray: true })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listAdmin(
    @Param('lang', LangParamPipe) pathLang: Language,
    @Param('bookId') bookId: string,
    @Query('language') language?: string,
    @Query('type') type?: string,
    @Query('isFree') isFree?: string,
    @Headers('x-admin-language') adminLangHeader?: string,
  ) {
    const headerLang = (adminLangHeader || '').toLowerCase();
    const pathEff = (Object.values(Language) as string[]).includes(headerLang)
      ? (headerLang as Language)
      : pathLang;
    const langEnum =
      language && Object.values(Language).includes(language as Language)
        ? (language as Language)
        : pathEff; // по умолчанию — язык из контекста админки (заголовок > путь)
    const typeEnum =
      type && Object.values(BookType).includes(type as BookType) ? (type as BookType) : undefined;
    return this.service.listAdmin(bookId, {
      language: langEnum,
      type: typeEnum,
      isFree: isFree !== undefined ? isFree === 'true' : undefined,
    });
  }

  @Get('versions/:id')
  @ApiOperation({ summary: 'Get version by id' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({
    description: 'Found (published only for public endpoint)',
    type: PublicBookVersionDetailResponseDto,
    examples: {
      published: {
        summary: 'Published version',
        value: {
          id: '0c1c1e5a-1111-2222-3333-444444444444',
          bookId: 'a1111111-b222-4c33-d444-555555555555',
          language: 'en',
          title: "Harry Potter and the Philosopher's Stone",
          author: 'J.K. Rowling',
          description: 'First book of the series',
          coverImageUrl: 'https://cdn.example.com/covers/hp1.jpg',
          type: 'text',
          isFree: true,
          status: 'published',
          publishedAt: '2025-08-25T13:00:00.000Z',
          createdAt: '2025-08-25T12:00:00.000Z',
          updatedAt: '2025-08-25T13:00:00.000Z',
          seo: {
            metaTitle: 'Harry Potter — Summary',
            metaDescription: 'Overview, themes and details about the book',
          },
          categories: [],
          tags: [],
        },
      },
    },
  })
  get(@Param('id') id: string, @Headers() headers: GeoRequestHeaders) {
    return this.service.getPublic(id, this.geoIpCountryService.resolveCountry(headers));
  }

  @Get('versions/:id/preview')
  @ApiOperation({
    summary: 'Get preview audio for a version (public)',
    description:
      'Возвращает URL и длительность preview-аудио для версии. 404, если preview не задан или версия не опубликована.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({
    status: 200,
    description: 'Preview metadata',
    schema: {
      type: 'object',
      properties: {
        previewUrl: { type: 'string', example: 'https://cdn.example.com/previews/hp1-en.mp3' },
        duration: { type: 'integer', nullable: true, example: 45 },
        contentType: { type: 'string', example: 'audio/mpeg' },
      },
    },
  })
  getPreview(@Param('id') id: string, @Headers() headers: GeoRequestHeaders) {
    return this.service.getPreview(id, this.geoIpCountryService.resolveCountry(headers));
  }

  @Get('admin/versions/:id')
  @ApiOperation({
    summary: 'Admin: Get version by id (any status)',
    description: 'Возвращает версию в любом статусе (draft, published). Требует авторизации.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({
    description: 'Version found (any status)',
    type: BookVersionAdminDetailResponseDto,
    examples: {
      draft: {
        summary: 'Draft version',
        value: {
          id: '0c1c1e5a-1111-2222-3333-444444444444',
          bookId: 'a1111111-b222-4c33-d444-555555555555',
          language: 'en',
          title: "Harry Potter and the Philosopher's Stone",
          author: 'J.K. Rowling',
          description: 'First book of the series',
          coverImageUrl: 'https://cdn.example.com/covers/hp1.jpg',
          type: 'text',
          isFree: true,
          referralUrl: 'https://amazon.com/ref123',
          status: 'draft',
          publishedAt: null,
          createdAt: '2025-08-25T12:00:00.000Z',
          updatedAt: '2025-08-25T12:00:00.000Z',
          seo: {
            metaTitle: 'Harry Potter — Summary',
            metaDescription: 'Overview, themes and details about the book',
          },
        },
      },
    },
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  getAdmin(@Param('id') id: string) {
    return this.service.getAdmin(id);
  }

  @Get('admin/versions/:id/rights-dashboard')
  @ApiOperation({
    summary: 'Admin: Get consolidated rights dashboard for a book version',
    description:
      'Возвращает агрегированный дашборд авторских прав: статус заявки, профиль прав, геоблокировку, проверки и историю.',
  })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({
    status: 200,
    description: 'Consolidated rights dashboard payload',
    type: BookRightsDashboardDto,
  })
  getRightsDashboard(@Param('id') id: string) {
    return this.service.getRightsDashboard(id);
  }

  @Get('admin/versions/:id/license-coverage')
  @ApiOperation({
    summary: 'Admin: Evaluate license coverage for a book version',
    description:
      'Возвращает покрытие лицензиями рынков со статусом LICENSE_REQUIRED: по странам, блокеры и предупреждения.',
  })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({ status: 200, type: LicenseCoverageResultDto })
  getLicenseCoverage(@Param('id') id: string): Promise<LicenseCoverageResultDto> {
    return this.licenseCoverageService.evaluateVersionCoverage(id);
  }

  @Get('admin/versions/:id/rights-claims')
  @ApiOperation({
    summary: 'Admin: List rights claims affecting a book version',
    description:
      'Возвращает претензии, поданные на эту версию, и претензии на книгу целиком (без bookVersionId).',
  })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({ status: 200, type: RightsClaimListResponseDto })
  getVersionRightsClaims(@Param('id') id: string): Promise<RightsClaimListResponseDto> {
    return this.rightsClaimsService.listForVersion(id);
  }

  @Get('admin/books/:id/rights-claims')
  @ApiOperation({
    summary: 'Admin: List rights claims for a book across all versions',
  })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({ status: 200, type: RightsClaimListResponseDto })
  getBookRightsClaims(@Param('id') id: string): Promise<RightsClaimListResponseDto> {
    return this.rightsClaimsService.listForBook(id);
  }

  @Patch('versions/:id')
  @ApiOperation({ summary: 'Update version by id' })
  @ApiBody({
    type: UpdateBookVersionDto,
    examples: {
      updateTitle: {
        summary: 'Update title and SEO',
        value: {
          title: "Harry Potter and the Sorcerer's Stone",
          seoMetaTitle: 'HP1 — Summary (Updated)',
          seoMetaDescription: 'New meta description text',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Updated',
    type: BookVersionResponseDto,
    examples: {
      updated: {
        summary: 'Updated version',
        value: {
          id: '0c1c1e5a-1111-2222-3333-444444444444',
          bookId: 'a1111111-b222-4c33-d444-555555555555',
          language: 'en',
          title: "Harry Potter and the Sorcerer's Stone",
          author: 'J.K. Rowling',
          description: 'Updated description text',
          coverImageUrl: 'https://cdn.example.com/covers/hp1-new.jpg',
          type: 'text',
          isFree: true,
          referralUrl: 'https://amazon.com/ref123',
          status: 'draft',
          publishedAt: null,
          createdAt: '2025-08-25T12:00:00.000Z',
          updatedAt: '2025-08-25T12:30:00.000Z',
          seo: {
            metaTitle: 'HP1 — Summary (Updated)',
            metaDescription: 'New meta description text',
          },
        },
      },
    },
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateBookVersionDto) {
    return this.service.update(id, dto);
  }

  @Delete('versions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete version by id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Patch('versions/:id/publish')
  @ApiOperation({ summary: 'Publish version' })
  @ApiOkResponse({
    description: 'Published',
    type: BookVersionResponseDto,
    examples: {
      published: {
        summary: 'Version published',
        value: {
          id: '0c1c1e5a-1111-2222-3333-444444444444',
          bookId: 'a1111111-b222-4c33-d444-555555555555',
          language: 'en',
          title: "Harry Potter and the Philosopher's Stone",
          author: 'J.K. Rowling',
          description: 'First book of the series',
          coverImageUrl: 'https://cdn.example.com/covers/hp1.jpg',
          type: 'text',
          isFree: true,
          referralUrl: 'https://amazon.com/ref123',
          status: 'published',
          publishedAt: '2025-08-25T13:00:00.000Z',
          createdAt: '2025-08-25T12:00:00.000Z',
          updatedAt: '2025-08-25T13:00:00.000Z',
          seo: {
            metaTitle: 'Harry Potter — Summary',
            metaDescription: 'Overview, themes and details about the book',
          },
        },
      },
    },
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @Patch('versions/:id/unpublish')
  @ApiOperation({ summary: 'Unpublish version (set draft)' })
  @ApiOkResponse({
    description: 'Unpublished (set to draft)',
    type: BookVersionResponseDto,
    examples: {
      unpublished: {
        summary: 'Version is now draft',
        value: {
          id: '0c1c1e5a-1111-2222-3333-444444444444',
          bookId: 'a1111111-b222-4c33-d444-555555555555',
          language: 'en',
          title: "Harry Potter and the Philosopher's Stone",
          author: 'J.K. Rowling',
          description: 'First book of the series',
          coverImageUrl: 'https://cdn.example.com/covers/hp1.jpg',
          type: 'text',
          isFree: true,
          referralUrl: 'https://amazon.com/ref123',
          status: 'draft',
          publishedAt: null,
          createdAt: '2025-08-25T12:00:00.000Z',
          updatedAt: '2025-08-25T13:10:00.000Z',
          seo: {
            metaTitle: 'Harry Potter — Summary',
            metaDescription: 'Overview, themes and details about the book',
          },
        },
      },
    },
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  unpublish(@Param('id') id: string) {
    return this.service.unpublish(id);
  }

  @Get('admin/versions/:id/publication-gate')
  @ApiOkResponse({ type: PublicationGateResultDto })
  @ApiOperation({
    summary: 'Check publication gate for a version',
    description:
      'Возвращает структурированный результат проверки publication gate: может ли версия быть опубликована, и если нет — причины блокировки.',
  })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkPublicationGate(@Param('id') id: string): Promise<PublicationGateResultDto> {
    return this.publicationGateService.checkVersionCanPublish(id);
  }

  @Patch('admin/versions/:id/rights-geo-block')
  @ApiOperation({
    summary: 'Mark geo-block as configured for a version',
    description:
      'Deprecated compatibility wrapper. Verification now requires generated active rules.',
    deprecated: true,
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateRightsGeoBlockDto })
  @ApiOkResponse({ type: GeoBlockRulesResponseDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async updateRightsGeoBlock(
    @Param('id') id: string,
    @Body() dto: UpdateRightsGeoBlockDto,
    @Req() request: { user: { userId: string } },
  ) {
    return this.geoBlockRuleService.verifyRulesForVersion(
      id,
      { verified: dto.configured, notesRu: dto.notesRu },
      request.user.userId,
    );
  }

  @Get('admin/versions/:id/rights-content-hash')
  @ApiOperation({
    summary: 'Get computed rights content hash for a version',
    description:
      'Вычисляет текущий content hash версии без изменения состояния. Возвращает результат сравнения с baseline.',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: RightsContentHashCheckDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async getRightsContentHash(@Param('id') id: string): Promise<RightsContentHashCheckDto> {
    return this.rightsContentHashService.checkVersionStaleness(
      id,
      'MANUAL_HASH_CHECK',
      null,
      false,
    );
  }

  @Post('admin/versions/:id/rights-content-hash/check')
  @ApiOperation({
    summary: 'Check rights content hash and mark stale if mismatch',
    description:
      'Вычисляет текущий content hash, сравнивает с baseline. Если есть расхождение, фиксирует stale.',
  })
  @ApiParam({ name: 'id' })
  @ApiCreatedResponse({ type: RightsContentHashCheckDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkRightsContentHash(@Param('id') id: string): Promise<RightsContentHashCheckDto> {
    return this.rightsContentHashService.checkVersionStaleness(id, 'MANUAL_HASH_CHECK', null, true);
  }

  @Get('admin/versions/:id/contributors')
  @ApiOperation({ summary: 'Get list of contributors for a book version' })
  @ApiResponse({ status: 200, type: [BookVersionContributorResponseDto] })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async getVersionContributors(@Param('id') id: string) {
    return this.service.getVersionContributors(id);
  }

  @Post('admin/versions/:id/contributors')
  @ApiOperation({ summary: 'Add a contributor to a book version' })
  @ApiResponse({ status: 201, type: BookVersionContributorResponseDto })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async addVersionContributor(
    @Param('id') id: string,
    @Body() dto: CreateBookVersionContributorDto,
  ) {
    return this.service.addVersionContributor(id, dto);
  }

  @Patch('admin/versions/:id/contributors/:contributorId')
  @ApiOperation({ summary: 'Update a contributor for a book version' })
  @ApiResponse({ status: 200, type: BookVersionContributorResponseDto })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'contributorId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async updateVersionContributor(
    @Param('id') id: string,
    @Param('contributorId') contributorId: string,
    @Body() dto: UpdateBookVersionContributorDto,
  ) {
    return this.service.updateVersionContributor(id, contributorId, dto);
  }

  @Delete('admin/versions/:id/contributors/:contributorId')
  @ApiOperation({ summary: 'Remove a contributor from a book version' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'contributorId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async removeVersionContributor(
    @Param('id') id: string,
    @Param('contributorId') contributorId: string,
  ) {
    return this.service.removeVersionContributor(id, contributorId);
  }

  @Post('admin/versions/:id/contributors/reorder')
  @ApiOperation({ summary: 'Reorder contributors for a book version' })
  @ApiResponse({ status: 200, type: [BookVersionContributorResponseDto] })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async reorderVersionContributors(
    @Param('id') id: string,
    @Body() dto: ReorderBookVersionContributorsDto,
  ) {
    return this.service.reorderVersionContributors(id, dto);
  }
}
