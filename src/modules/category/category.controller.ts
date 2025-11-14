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
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CategoryTreeNodeDto } from './dto/category-tree-node.dto';
import { CategoryService } from './category.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { AttachCategoryDto } from './dto/attach-category.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { CreateCategoryTranslationDto } from './dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from './dto/update-category-translation.dto';
import { Language } from '@prisma/client';

@ApiTags('categories')
@Controller()
export class CategoryController {
  constructor(private readonly service: CategoryService) {}

  @Get('categories')
  @ApiOperation({ summary: 'List categories' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  list(@Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    return this.service.list(page, limit);
  }

  @Get('categories/tree')
  @ApiOperation({ summary: 'Get full categories tree (root nodes with nested children)' })
  @ApiOkResponse({
    description: 'Array of root categories with nested children',
    type: [CategoryTreeNodeDto],
  })
  tree() {
    return this.service.getTree();
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateCategoryDto) {
    return this.service.create(dto);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update category' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.service.update(id, dto);
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete category' })
  @ApiParam({ name: 'id' })
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

  // Public route with a language prefix
  @Get(':lang/categories/:slug/books')
  @ApiOperation({ summary: 'Public list of book versions by category (with language prefix)' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiParam({ name: 'slug' })
  publicByLangSlug(@Param('lang') lang: Language, @Param('slug') slug: string) {
    return this.service.getByLangSlugWithBooks(lang, slug);
  }

  // === Translations (Admin) ===
  @Get('categories/:id/translations')
  @ApiOperation({ summary: 'List category translations (admin)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listTranslations(@Param('id') id: string) {
    return this.service.listTranslations(id);
  }

  @Post('categories/:id/translations')
  @ApiOperation({ summary: 'Create category translation (admin)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  createTranslation(@Param('id') id: string, @Body() dto: CreateCategoryTranslationDto) {
    return this.service.createTranslation(id, dto);
  }

  @Patch('categories/:id/translations/:language')
  @ApiOperation({ summary: 'Update category translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  deleteTranslation(@Param('id') id: string, @Param('language') language: Language) {
    return this.service.deleteTranslation(id, language);
  }

  @Post('versions/:id/categories')
  @ApiOperation({ summary: 'Attach category to a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  detach(@Param('id') versionId: string, @Param('categoryId') categoryId: string) {
    return this.service.detachCategoryFromVersion(versionId, categoryId);
  }
}
