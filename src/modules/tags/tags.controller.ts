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
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { AttachTagDto } from './dto/attach-tag.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { CreateTagTranslationDto } from './dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from './dto/update-tag-translation.dto';
import { Language } from '@prisma/client';

@ApiTags('tags')
@Controller()
export class TagsController {
  constructor(private readonly service: TagsService) {}

  @Get('tags')
  @ApiOperation({ summary: 'List tags' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  list(@Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    return this.service.list(page, limit);
  }

  @Post('tags')
  @ApiOperation({ summary: 'Create tag' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateTagDto) {
    return this.service.create(dto);
  }

  @Patch('tags/:id')
  @ApiOperation({ summary: 'Update tag' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.service.update(id, dto);
  }

  @Delete('tags/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tag' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // Note: публичный путь теперь обрабатывается в PublicController (/:lang/tags/:slug/books)
  // Публичный путь без префикса языка (обратная совместимость)
  @Get('tags/:slug/books')
  @ApiOperation({ summary: 'Публичный список версий книги по тегу (без префикса языка)' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'lang', required: false, description: 'Опциональный язык (?lang=...)' })
  @ApiHeader({ name: 'Accept-Language', required: false })
  publicBySlug(
    @Param('slug') slug: string,
    @Query('lang') queryLang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    return this.service.versionsByTagSlug(slug, queryLang, acceptLanguage);
  }

  @Post('versions/:id/tags')
  @ApiOperation({ summary: 'Attach tag to a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  attach(@Param('id') versionId: string, @Body() dto: AttachTagDto) {
    return this.service.attach(versionId, dto.tagId);
  }

  @Delete('versions/:id/tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach tag from a book version' })
  @ApiParam({ name: 'id', description: 'BookVersion id' })
  @ApiParam({ name: 'tagId', description: 'Tag id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  detach(@Param('id') versionId: string, @Param('tagId') tagId: string) {
    return this.service.detach(versionId, tagId);
  }

  // === Translations (Admin) ===
  @Get('tags/:id/translations')
  @ApiOperation({ summary: 'List tag translations (admin)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listTranslations(@Param('id') id: string) {
    return this.service.listTranslations(id);
  }

  @Post('tags/:id/translations')
  @ApiOperation({ summary: 'Create tag translation (admin)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  createTranslation(@Param('id') id: string, @Body() dto: CreateTagTranslationDto) {
    return this.service.createTranslation(id, dto);
  }

  @Patch('tags/:id/translations/:language')
  @ApiOperation({ summary: 'Update tag translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tag translation (admin)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'language', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  deleteTranslation(@Param('id') id: string, @Param('language') language: Language) {
    return this.service.deleteTranslation(id, language);
  }
}
