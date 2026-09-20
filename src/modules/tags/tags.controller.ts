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
} from '@nestjs/swagger';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { AttachTagDto } from './dto/attach-tag.dto';
import { ListTagsDto } from './dto/list-tags.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { CreateTagTranslationDto } from './dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from './dto/update-tag-translation.dto';
import { Language } from '@prisma/client';
import { PaginatedTagsResponse } from './dto/tag-response.dto';
import { CheckTagSlugQueryDto } from './dto/check-slug-query.dto';
import { CheckTagSlugResponseDto } from './dto/check-slug-response.dto';
import { TagEntityDto } from './dto/tag-entity.dto';
import { TagTranslationEntityDto } from './dto/tag-translation-entity.dto';
import { VersionTagLinkDto } from './dto/version-tag-link.dto';

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

@ApiTags('tags')
@Controller()
export class TagsController {
  constructor(private readonly service: TagsService) {}

  /**
   * LEGACY-061: своей проверки у тегов не было, и форма проверяла слаг **по книгам**.
   * Форма ответа повторяет категории — фронт использует общий хук.
   */
  @Get('tags/check-slug')
  @ApiOperation({
    summary: 'Check slug uniqueness for a tag',
    description:
      'Quick availability check for a slug. Returns info about an existing tag and suggests a unique option if the slug is taken.',
  })
  @ApiResponse({ status: 200, description: 'Slug check result', type: CheckTagSlugResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid slug format' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query() query: CheckTagSlugQueryDto): Promise<CheckTagSlugResponseDto> {
    const existingTag = await this.service.checkSlugExists(query.slug, query.excludeId);
    if (!existingTag) return { exists: false };

    return {
      exists: true,
      suggestedSlug: await this.service.generateUniqueSuggestedSlug(query.slug),
      existingTag: {
        id: existingTag.id,
        name: existingTag.name,
        slug: existingTag.slug,
      },
    };
  }

  @Get('tags')
  @ApiOperation({ summary: 'List tags' })
  @ApiResponse({ status: 200, type: PaginatedTagsResponse })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'lang', required: false, enum: Language })
  list(
    @Query() query?: ListTagsDto,
    @Query('lang') lang?: Language,
  ): Promise<PaginatedTagsResponse> {
    const page = query?.page ?? 1;
    const limit = query?.limit ?? 20;
    return this.service.list(page, limit, query?.q, lang);
  }

  @Post('tags')
  @ApiOperation({ summary: 'Create tag' })
  @ApiCreatedResponse({ type: TagEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateTagDto) {
    return this.service.create(dto);
  }

  @Patch('tags/:id')
  @ApiOperation({ summary: 'Update tag' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: TagEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.service.update(id, dto);
  }

  @Delete('tags/:id')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tag' })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string, @Req() req: { user: RequestUser }) {
    // Актёр берётся из запроса, а не из тела: журнал должен отвечать «кто»,
    // а не «кто представился» (`LEGACY-015`).
    return this.service.remove(id, req.user.userId);
  }

  @Post('versions/:id/tags')
  @ApiOperation({ summary: 'Attach tag to a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @ApiCreatedResponse({ type: VersionTagLinkDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  attach(@Param('id') versionId: string, @Body() dto: AttachTagDto) {
    return this.service.attach(versionId, dto.tagId);
  }

  @Delete('versions/:id/tags/:tagId')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach tag from a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @ApiParam({ name: 'tagId', description: 'Tag id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  detach(@Param('id') versionId: string, @Param('tagId') tagId: string) {
    return this.service.detach(versionId, tagId);
  }

  // === Translations (Admin) ===
  @Get('tags/:id/translations')
  @ApiOperation({ summary: 'List tag translations (admin)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: TagTranslationEntityDto, isArray: true })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listTranslations(@Param('id') id: string) {
    return this.service.listTranslations(id);
  }

  @Post('tags/:id/translations')
  @ApiOperation({ summary: 'Create tag translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiCreatedResponse({ type: TagTranslationEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  createTranslation(@Param('id') id: string, @Body() dto: CreateTagTranslationDto) {
    return this.service.createTranslation(id, dto);
  }

  @Patch('tags/:id/translations/:language')
  @ApiOperation({ summary: 'Update tag translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
  @ApiOkResponse({ type: TagTranslationEntityDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  updateTranslation(
    @Param('id') id: string,
    @Param('language') language: Language,
    @Body() dto: UpdateTagTranslationDto,
  ) {
    return this.service.updateTranslation(id, language, dto);
  }

  @Delete('tags/:id/translations/:language')
  @ApiNoContentResponse({ description: 'Deleted; no body' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tag translation (admin)' })
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
}
