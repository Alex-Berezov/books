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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiNoContentResponse,
  ApiExtraModels,
} from '@nestjs/swagger';
import { CategoryType, Language, Prisma } from '@prisma/client';
import { CategoryTreeNodeDto } from './dto/category-tree-node.dto';
import { CategoryService } from './category.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { AttachCategoryDto } from './dto/attach-category.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { CreateCategoryTranslationDto } from './dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from './dto/update-category-translation.dto';
import { CheckCategorySlugQueryDto } from './dto/check-slug-query.dto';
import { CheckCategorySlugResponseDto } from './dto/check-slug-response.dto';
import { CategoryResponse, PaginatedCategoriesResponse } from './dto/category-response.dto';
import {
  paginated,
  paginatedSchema,
  type PaginatedResult,
} from '../../shared/dto/paginated-response.dto';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { CategoryEntityDto } from './dto/category-entity.dto';
import { CategoryAncestorDto } from './dto/category-ancestor.dto';
import { CategoryTranslationEntityDto } from './dto/category-translation-entity.dto';
import { VersionCategoryLinkDto } from './dto/version-category-link.dto';

/**
 * Форма пользователя запроса — та же, что в остальных контроллерах
 * (`STYLE_GUIDE.md`, раздел «Контроллеры»). Общего `@CurrentUser()` в проекте
 * нет вовсе, и сведение копий к одному декоратору — отдельная работа,
 * записанная строкой в теле `LEGACY-015`.
 */
interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('categories')
@ApiExtraModels(CategoryResponse)
@Controller()
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Get('categories/check-slug')
  @ApiOperation({
    summary: 'Check slug uniqueness for a category',
    description:
      'Quick availability check for a slug. Returns info about an existing category and suggests a unique option if the slug is taken.',
  })
  @ApiResponse({
    status: 200,
    description: 'Slug check result',
    type: CheckCategorySlugResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid slug format',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(
    @Query() query: CheckCategorySlugQueryDto,
  ): Promise<CheckCategorySlugResponseDto> {
    const existingCategory = await this.service.checkSlugExists(query.slug, query.excludeId);

    if (!existingCategory) {
      return { exists: false };
    }

    const suggestedSlug = await this.service.generateUniqueSuggestedSlug(query.slug);

    return {
      exists: true,
      suggestedSlug,
      existingCategory: {
        id: existingCategory.id,
        name: existingCategory.name,
        slug: existingCategory.slug,
      },
    };
  }

  /**
   * Административный список терминов — для пикеров админки (`LEGACY-387`).
   *
   * Заведён, чтобы можно было снять безъязыкий `GET /categories`, не сажая админское
   * чтение на публичный `GET /:lang/categories`: тот идёт под `PublicCacheInterceptor`
   * (`public.controller.ts:67-68`) и отдаётся с `public, s-maxage=300,
   * stale-while-revalidate=3600`. Заведённая контент-менеджером категория не появлялась
   * бы в пикере до часа — «категория не сохранилась» (решение арбитра 22.09.2026,
   * `decisions-log.md`). Здесь же умолчание `private, no-store`.
   *
   * Форма ответа — общая для всего, что за логином: `{items, pagination}` (`LEGACY-177`).
   */
  @Get('admin/categories')
  @ApiOperation({ summary: 'List categories for admin pickers' })
  @ApiOkResponse({ schema: paginatedSchema(CategoryResponse) })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async adminList(@Query() query: ListCategoriesQueryDto): Promise<PaginatedResult<unknown>> {
    const { data, meta } = await this.service.list(query.page, query.limit, query.type, query.lang);
    return paginated(data, { page: meta.page, limit: meta.limit, total: meta.total });
  }

  @Get('categories')
  @ApiOperation({ summary: 'List categories (optionally filtered by type)' })
  @ApiResponse({ status: 200, type: PaginatedCategoriesResponse })
  async list(@Query() query: ListCategoriesQueryDto): Promise<PaginatedCategoriesResponse> {
    // 🔴 `page`/`limit` раньше шли голым `ParseIntPipe` без верхней границы вовсе:
    // `?limit=100000` проходил приведение типа и уезжал в `take` Prisma как есть
    // (`LEGACY-298`, схлопнута сюда `LEGACY-353`).
    return this.service.list(query.page, query.limit, query.type, query.lang);
  }

  @Get('categories/tree')
  @ApiOperation({ summary: 'Get categories tree (optionally filtered by type)' })
  @ApiOkResponse({
    description: 'Array of root categories with nested children',
    type: [CategoryTreeNodeDto],
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: CategoryType,
    description: 'Filter by category type (category|genre|collection)',
  })
  tree(@Query('type') type?: CategoryType, @Query('lang') lang?: Language) {
    return this.service.getTree(type, lang);
  }

  @Get('categories/:id/children')
  @ApiOperation({ summary: 'Get direct children of the category' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({
    description: 'Array of direct child categories',
    type: [CategoryTreeNodeDto],
  })
  children(@Param('id') id: string) {
    return this.service.getChildren(id);
  }

  @Get('categories/:id/ancestors')
  @ApiOperation({ summary: 'Get ancestors path of the category (root → ... → parent)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({
    description: 'Array from root to parent (excluding the node itself)',
    type: CategoryAncestorDto,
    isArray: true,
  })
  ancestors(@Param('id') id: string) {
    return this.service.getAncestors(id);
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create category' })
  @ApiCreatedResponse({ type: CategoryEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateCategoryDto) {
    return this.service.create(dto);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update category' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: CategoryEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.service.update(id, dto);
  }

  @Delete('categories/:id')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete category' })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string, @Req() req: { user: RequestUser }) {
    // Актёр берётся из запроса, а не из тела: журнал должен отвечать «кто»,
    // а не «кто представился» (`LEGACY-015`).
    return this.service.remove(id, req.user.userId);
  }

  /**
   * ⚠️ Маршрут `:lang/categories/:slug/books` объявлялся **здесь и одновременно**
   * в `PublicController` (`LEGACY-091`). Исход решал порядок модулей в
   * `app.module.ts`, и побеждала эта, менее защищённая копия. Проверено на
   * проде 10.08.2026: `/xx/categories/non-fiction/books` отвечал **500** вместо
   * 400 (здесь нет `LangParamPipe`), а `Cache-Control` не приходил вовсе
   * (здесь нет `PublicCacheInterceptor`).
   *
   * Дубль убран, объявление осталось одно — в `PublicController`. Опасность
   * была не в самом дублировании, а в том, что любой гвард или фильтр, надетый
   * на «мёртвую» копию, не давал бы никакого эффекта и выглядел бы как защита.
   */

  // === Translations (Admin) ===

  /**
   * Тип возврата выписан явно, потому что `CategoryService.listTranslations`
   * отдаёт `Prisma.PrismaPromise`, а не `Promise`: сторож
   * `yarn check:response-schema` разворачивает только `Promise` и без этой
   * строки читал форму ответа как объект без свойств. Сама форма та же, что у
   * `POST`/`PATCH` того же ресурса — запись перевода целиком плюс `seo`.
   */
  @Get('categories/:id/translations')
  @ApiOperation({ summary: 'List category translations (admin)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: CategoryTranslationEntityDto, isArray: true })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listTranslations(
    @Param('id') id: string,
  ): Promise<Prisma.CategoryTranslationGetPayload<{ include: { seo: true } }>[]> {
    return this.service.listTranslations(id);
  }

  @Post('categories/:id/translations')
  @ApiOperation({ summary: 'Create category translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiCreatedResponse({ type: CategoryTranslationEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  createTranslation(@Param('id') id: string, @Body() dto: CreateCategoryTranslationDto) {
    return this.service.createTranslation(id, dto);
  }

  @Patch('categories/:id/translations/:language')
  @ApiOperation({ summary: 'Update category translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
  @ApiOkResponse({ type: CategoryTranslationEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  updateTranslation(
    @Param('id') id: string,
    @Param('language') language: Language,
    @Body() dto: UpdateCategoryTranslationDto,
  ) {
    return this.service.updateTranslation(id, language, dto);
  }

  @Delete('categories/:id/translations/:language')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete category translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  deleteTranslation(
    @Param('id') id: string,
    @Param('language') language: Language,
    @Req() req: { user: RequestUser },
  ) {
    return this.service.deleteTranslation(id, language, req.user.userId);
  }

  @Post('versions/:id/categories')
  @ApiOperation({ summary: 'Attach category to a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @ApiCreatedResponse({ type: VersionCategoryLinkDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  attach(@Param('id') versionId: string, @Body() dto: AttachCategoryDto) {
    return this.service.attachCategoryToVersion(versionId, dto.categoryId);
  }

  @Delete('versions/:id/categories/:categoryId')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach category from a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @ApiParam({ name: 'categoryId', description: 'Category id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  detach(@Param('id') versionId: string, @Param('categoryId') categoryId: string) {
    return this.service.detachCategoryFromVersion(versionId, categoryId);
  }
}
