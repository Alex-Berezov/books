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
  UseGuards,
  Headers,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CategoryType, Language } from '@prisma/client';
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
import { CheckSlugQueryDto } from './dto/check-slug-query.dto';
import { CheckCategorySlugResponseDto } from './dto/check-slug-response.dto';
import { PaginatedCategoriesResponse } from './dto/category-response.dto';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';

@ApiTags('categories')
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
  async checkSlug(@Query() query: CheckSlugQueryDto): Promise<CheckCategorySlugResponseDto> {
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
  @ApiOkResponse({ description: 'Array from root to parent (excluding the node itself)' })
  ancestors(@Param('id') id: string) {
    return this.service.getAncestors(id);
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create category' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateCategoryDto) {
    return this.service.create(dto);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update category' })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.service.update(id, dto);
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete category' })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // Public route without language prefix (for backward compatibility)
  @Get('categories/:slug/books')
  @ApiOperation({ summary: 'Public list of book versions by category (without language prefix)' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'lang', required: false, description: 'Optional language (?lang=...)' })
  @ApiHeader({ name: 'Accept-Language', required: false })
  publicBySlug(
    @Param('slug') slug: string,
    @Query('lang') queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.service.getBySlugWithBooks(slug, queryLang, acceptLanguage);
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
  @Get('categories/:id/translations')
  @ApiOperation({ summary: 'List category translations (admin)' })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listTranslations(@Param('id') id: string) {
    return this.service.listTranslations(id);
  }

  @Post('categories/:id/translations')
  @ApiOperation({ summary: 'Create category translation (admin)' })
  @ApiParam({ name: 'id' })
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete category translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  deleteTranslation(@Param('id') id: string, @Param('language') language: Language) {
    return this.service.deleteTranslation(id, language);
  }

  @Post('versions/:id/categories')
  @ApiOperation({ summary: 'Attach category to a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  attach(@Param('id') versionId: string, @Body() dto: AttachCategoryDto) {
    return this.service.attachCategoryToVersion(versionId, dto.categoryId);
  }

  @Delete('versions/:id/categories/:categoryId')
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
