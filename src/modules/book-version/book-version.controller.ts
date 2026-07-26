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
  Headers,
  Req,
} from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { PublicationGateService } from './publication-gate.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';
import {
  PublicationGateResultDto,
  UpdateRightsGeoBlockDto,
} from './dto/publication-gate-result.dto';
import { BookRightsDashboardDto } from './dto/rights-dashboard.dto';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { RightsContentHashCheckDto } from '../rights-intake/dto/rights-content-hash.dto';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiBody,
  ApiHeader,
} from '@nestjs/swagger';
import { Language, BookType } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoIpCountryService, GeoRequestHeaders } from '../geo-block/geo-ip-country.service';

@ApiTags('book-versions')
@Controller()
export class BookVersionController {
  constructor(
    private readonly service: BookVersionService,
    private readonly publicationGateService: PublicationGateService,
    private readonly rightsContentHashService: RightsContentHashService,
    private readonly geoIpCountryService: GeoIpCountryService,
    private readonly geoBlockRuleService: GeoBlockRuleService,
  ) {}

  @Get('books/:bookId/versions')
  @ApiOperation({
    summary: 'List versions for a book (public)',
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
      'Только для админов/контент-менеджеров (требует авторизации и ролей). Если true — возвращает также черновики.',
  })
  list(
    @Param('bookId') bookId: string,
    @Query('language') language?: string,
    @Query('type') type?: string,
    @Query('isFree') isFree?: string,
    @Query('includeDrafts') includeDrafts?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const langEnum =
      language && Object.values(Language).includes(language as Language)
        ? (language as Language)
        : undefined;
    const typeEnum =
      type && Object.values(BookType).includes(type as BookType) ? (type as BookType) : undefined;
    // Если includeDrafts=true и пользователь админ — используем admin-листинг
    if (includeDrafts === 'true') {
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
  @ApiResponse({
    status: 201,
    description: 'Created',
    content: {
      'application/json': {
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
      },
    },
  })
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
  @ApiResponse({
    status: 200,
    description: 'Found (published only for public endpoint)',
    content: {
      'application/json': {
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({
    status: 200,
    description: 'Version found (any status)',
    content: {
      'application/json': {
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
      },
    },
  })
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({
    status: 200,
    description: 'Updated',
    content: {
      'application/json': {
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
      },
    },
  })
  update(@Param('id') id: string, @Body() dto: UpdateBookVersionDto) {
    return this.service.update(id, dto);
  }

  @Delete('versions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete version by id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Patch('versions/:id/publish')
  @ApiOperation({ summary: 'Publish version' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({
    status: 200,
    description: 'Published',
    content: {
      'application/json': {
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
      },
    },
  })
  publish(@Param('id') id: string) {
    return this.service.publish(id);
  }

  @Patch('versions/:id/unpublish')
  @ApiOperation({ summary: 'Unpublish version (set draft)' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiResponse({
    status: 200,
    description: 'Unpublished (set to draft)',
    content: {
      'application/json': {
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
      },
    },
  })
  unpublish(@Param('id') id: string) {
    return this.service.unpublish(id);
  }

  @Get('admin/versions/:id/publication-gate')
  @ApiOperation({
    summary: 'Check publication gate for a version',
    description:
      'Возвращает структурированный результат проверки publication gate: может ли версия быть опубликована, и если нет — причины блокировки.',
  })
  @ApiParam({ name: 'id' })
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkRightsContentHash(@Param('id') id: string): Promise<RightsContentHashCheckDto> {
    return this.rightsContentHashService.checkVersionStaleness(id, 'MANUAL_HASH_CHECK', null, true);
  }
}
