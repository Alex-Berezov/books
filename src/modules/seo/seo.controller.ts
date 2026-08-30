import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
  Query,
  Headers,
} from '@nestjs/common';
import { PublicCacheInterceptor } from '../../common/interceptors/public-cache.interceptor';
import { ApiOperation, ApiParam, ApiTags, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { SeoService } from './seo.service';
import { TaxonomyIndexabilityService } from './indexability/taxonomy-indexability.service';
import { TaxonomyIndexabilitySchedulerService } from './indexability/taxonomy-indexability-scheduler.service';
import { SystemPagesService } from './system-pages/system-pages.service';
import { UpdateSeoDto } from './dto/update-seo.dto';
import { ResolveSeoType, ResolveSeoTypeValue } from './dto/resolve-seo.dto';
import { ApiHeader } from '@nestjs/swagger';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { Language } from '@prisma/client';

/**
 * Единственный список типов страниц, которые принимает `/seo/resolve`.
 *
 * `LEGACY-319`. До 30.08.2026 он был выписан руками четырежды: по `@ApiQuery`
 * и по массиву `allowed` на каждый из двух обработчиков. Копии разъехались -
 * `@ApiQuery` первого обработчика не знал `collection`, который рантайм
 * принимал, и OpenAPI отдавал перечисление без него. Ничто этого не ловило:
 * оба списка - литералы, компилятору сверять нечего.
 *
 * Источник - enum `ResolveSeoType`, он же валидирует `ResolveSeoQueryDto`.
 * `Object.values` берётся и в документацию, и в проверку, поэтому разойтись
 * им больше негде. Тот же приём уже стоял рядом на `@ApiParam({ enum:
 * Object.values(Language) })`.
 *
 * Словарь видов пути (`CanonicalPathType` в `canonical/getCanonicalUrl.ts`) -
 * другое понятие: там есть `author` и `static`, которых ручка не принимает,
 * и нет `catalog`. Объединять их нельзя, см. решение арбитра от 30.08.2026.
 */
const RESOLVE_SEO_TYPES = Object.values(ResolveSeoType);

const isResolveSeoType = (val: string): val is ResolveSeoTypeValue =>
  (RESOLVE_SEO_TYPES as readonly string[]).includes(val);

@ApiTags('seo')
@Controller()
export class SeoController {
  constructor(
    private readonly service: SeoService,
    private readonly taxonomyIndexability: TaxonomyIndexabilityService,
    private readonly scheduler: TaxonomyIndexabilitySchedulerService,
    private readonly systemPages: SystemPagesService,
  ) {}

  @Post('admin/seo/taxonomy-indexability/recompute')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({
    summary:
      'Recompute bookCount / autoIndexable for every taxonomy translation (hysteresis: close <=2, open >=5)',
  })
  @ApiResponse({ status: 201, description: 'Counters recomputed' })
  @ApiQuery({
    name: 'cold',
    required: false,
    enum: ['all', 'tags', 'categories'],
    description:
      'Reset autoIndexable to false before recomputing, so the 3-4 book hysteresis band resolves downwards instead of inheriting the schema default. Erases real state history — use deliberately, not routinely.',
  })
  recomputeTaxonomyIndexability(@Query('cold') cold?: string) {
    const coldOption =
      cold === 'all'
        ? { categories: true, tags: true }
        : cold === 'tags'
          ? { tags: true }
          : cold === 'categories'
            ? { categories: true }
            : undefined;
    return this.taxonomyIndexability.recomputeAll(coldOption);
  }

  @Get('admin/seo/taxonomy-indexability/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({
    summary: 'Last run of the daily taxonomy indexability sweep',
    description:
      'The sweep is the safety net that catches a counter no targeted hook updated. It runs in-process, so this is the only way to confirm from outside that it actually ran.',
  })
  @ApiResponse({ status: 200, description: 'Scheduler state and last run result' })
  taxonomyIndexabilityStatus() {
    return this.scheduler.getStatus();
  }

  @Get('admin/seo/system-pages/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({
    summary: 'Do the keys the public site resolves by still land on a published page?',
    description:
      'The homepage and the four taxonomy hubs are found by an immutable systemKey. When one no longer resolves — unpublished, deleted, or a language added after the backfill — nothing errors: the page falls back to dictionary strings and silently loses its meta, H1, SEO text and FAQ. This names the pages that no longer resolve, per language, with their current public slug. Also logged at startup.',
  })
  @ApiResponse({ status: 200, description: 'State of every system page, plus the problems only' })
  systemPagesStatus() {
    return this.systemPages.check();
  }

  @Get('versions/:bookVersionId/seo')
  @ApiOperation({ summary: 'Get SEO meta for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiResponse({ status: 200, description: 'SEO meta or null if not set' })
  get(@Param('bookVersionId') bookVersionId: string) {
    return this.service.getByVersion(bookVersionId);
  }

  @Put('versions/:bookVersionId/seo')
  @ApiOperation({ summary: 'Create or update SEO meta for a book version (upsert)' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBody({
    description: 'Partial SEO fields to upsert',
    schema: {
      type: 'object',
      properties: {
        metaTitle: { type: 'string', example: 'My SEO title' },
        metaDescription: { type: 'string', example: 'Concise description' },
        canonicalUrl: { type: 'string', example: 'https://example.com/books/1' },
        ogImageUrl: { type: 'string', example: 'https://cdn.example.com/og.jpg' },
        eventStartDate: { type: 'string', example: '2025-08-17T12:00:00Z' },
      },
    },
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateSeoDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }

  @Get('seo/resolve')
  @UseInterceptors(PublicCacheInterceptor)
  @ApiOperation({ summary: 'Resolve SEO bundle (meta/OG/Twitter/canonical) with fallbacks' })
  @ApiQuery({ name: 'type', enum: RESOLVE_SEO_TYPES })
  @ApiQuery({
    name: 'id',
    description: 'Entity identifier or slug (book/page). For version: id only.',
  })
  @ApiQuery({
    name: 'slug',
    required: false,
    description: 'Translation slug (for category/genre/tag)',
  })
  @ApiQuery({ name: 'lang', required: false, description: 'Requested language (en|es|fr|pt)' })
  @ApiHeader({ name: 'Accept-Language', required: false })
  @ApiResponse({ status: 200, description: 'Resolved SEO bundle' })
  resolve(
    @Query('type') typeRaw: string,
    @Query('id') idRaw: string,
    @Query('slug') slug?: string,
    @Query('lang') queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<any> {
    const t = String(typeRaw);
    const id = String(idRaw);
    if (!isResolveSeoType(t)) {
      throw new BadRequestException('Invalid type');
    }
    return this.service.resolvePublic(t, id, { queryLang, acceptLanguage, slug });
  }

  // Language-prefixed public resolver (prefix has higher priority than query/header)
  @Get(':lang/seo/resolve')
  @UseInterceptors(PublicCacheInterceptor)
  @ApiOperation({ summary: 'Resolve SEO bundle (public) for specific language (by path prefix)' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiQuery({ name: 'type', enum: RESOLVE_SEO_TYPES })
  @ApiQuery({
    name: 'id',
    description: 'Entity identifier or slug (book/page). For version: id only.',
  })
  @ApiQuery({
    name: 'slug',
    required: false,
    description: 'Translation slug (for category/genre/tag)',
  })
  @ApiHeader({ name: 'Accept-Language', required: false })
  @ApiResponse({ status: 200, description: 'Resolved SEO bundle' })
  resolveWithLang(
    @Param('lang', LangParamPipe) pathLang: Language,
    @Query('type') typeRaw: string,
    @Query('id') idRaw: string,
    @Query('slug') slug?: string,
    @Query('lang') queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<any> {
    const t = String(typeRaw);
    const id = String(idRaw);
    if (!isResolveSeoType(t)) {
      throw new BadRequestException('Invalid type');
    }
    return this.service.resolvePublic(t, id, { pathLang, queryLang, acceptLanguage, slug });
  }
}
