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
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PagesService } from './pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { Language } from '@prisma/client';
import { PageResponse, PaginatedPagesResponse } from './dto/page-response.dto';
import { CheckSlugQueryDto } from './dto/check-slug-query.dto';
import { CheckPageSlugResponseDto } from './dto/check-slug-response.dto';

@ApiTags('pages')
@Controller()
export class PagesController {
  constructor(private readonly service: PagesService) {}

  // ⚠️ КРИТИЧЕСКИ ВАЖНО: check-slug должен быть ПЕРВЫМ, перед ВСЕМИ другими роутами
  // иначе будет конфликт с admin/pages/:id (NestJS думает что "check-slug" - это UUID)
  @Get('admin/pages/check-slug')
  @ApiOperation({
    summary: 'Проверить уникальность slug для страницы',
    description:
      'Быстрая проверка доступности slug. Возвращает информацию о существующей странице и предлагает уникальный вариант если slug занят.',
  })
  @ApiQuery({
    name: 'lang',
    enum: Object.values(Language),
    description: 'Язык страницы',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Результат проверки slug',
    type: CheckPageSlugResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Невалидный формат slug',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query() query: CheckSlugQueryDto): Promise<CheckPageSlugResponseDto> {
    // lang is already validated by class-validator in CheckSlugQueryDto
    const lang = query.lang as Language;

    const existingPage = await this.service.checkSlugExists(query.slug, lang, query.excludeId);

    if (!existingPage) {
      // Slug is available
      return {
        exists: false,
      };
    }

    // Slug is taken - generate suggestion
    const suggestedSlug = await this.service.generateUniqueSuggestedSlug(query.slug, lang);

    return {
      exists: true,
      suggestedSlug,
      existingPage: {
        id: existingPage.id,
        title: existingPage.title,
        status: existingPage.status,
      },
    };
  }

  // Public: get page by slug (only published)
  @Get('pages/:slug')
  @ApiOperation({ summary: 'Публичная страница по slug (только published)' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({ name: 'lang', required: false, description: 'Запрошенный язык (en|es|fr|pt)' })
  @ApiHeader({ name: 'Accept-Language', required: false })
  getPublic(
    @Param('slug') slug: string,
    @Query('lang') lang?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ): Promise<any> {
    return this.service.getPublicBySlugWithPolicy(slug, lang, acceptLanguage);
  }

  @Get('admin/pages/:id')
  @ApiOperation({ summary: 'Получить страницу по ID (админ): любой статус' })
  @ApiParam({ name: 'id', description: 'UUID страницы' })
  @ApiResponse({ status: 200, type: PageResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  findById(@Param('id') id: string): Promise<PageResponse> {
    return this.service.findById(id);
  }

  // ⚠️ ВАЖНО: admin/:lang/pages ПОСЛЕ всех статических admin/pages/* роутов
  // иначе `:lang` может съесть статические сегменты типа "check-slug"
  @Get('admin/:lang/pages')
  @ApiOperation({ summary: 'Листинг страниц (админ): draft+published' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiHeader({ name: 'X-Admin-Language', required: false, description: 'Приоритетнее языка пути' })
  @ApiResponse({ status: 200, type: PaginatedPagesResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  adminList(
    @Param('lang', LangParamPipe) lang: Language,
    @Query() pagination?: PaginationDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ): Promise<PaginatedPagesResponse> {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    const headerLang = (adminLangHeader || '').toLowerCase();
    const effLang = (Object.values(Language) as string[]).includes(headerLang)
      ? (headerLang as Language)
      : lang;
    return this.service.adminList(page, limit, effLang);
  }

  @Post('admin/:lang/pages')
  @ApiOperation({ summary: 'Создать страницу (админ)' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiHeader({ name: 'X-Admin-Language', required: false, description: 'Приоритетнее языка пути' })
  @ApiResponse({ status: 201, type: PageResponse })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(
    @Param('lang', LangParamPipe) lang: Language,
    @Body() dto: CreatePageDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ): Promise<PageResponse> {
    const headerLang = (adminLangHeader || '').toLowerCase();
    const effLang = (Object.values(Language) as string[]).includes(headerLang)
      ? (headerLang as Language)
      : lang;
    return this.service.create(dto, effLang);
  }

  @Patch('admin/:lang/pages/:id')
  @ApiOperation({ summary: 'Обновить страницу (админ)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(
    @Param('lang', LangParamPipe) _lang: Language,
    @Param('id') id: string,
    @Body() dto: UpdatePageDto,
  ): Promise<any> {
    return this.service.update(id, dto);
  }

  @Delete('admin/:lang/pages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Удалить страницу (админ)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('lang', LangParamPipe) _lang: Language, @Param('id') id: string): Promise<any> {
    return this.service.remove(id);
  }

  @Patch('admin/:lang/pages/:id/publish')
  @ApiOperation({ summary: 'Опубликовать страницу' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  publish(@Param('lang', LangParamPipe) _lang: Language, @Param('id') id: string): Promise<any> {
    return this.service.setStatus(id, 'published');
  }

  @Patch('admin/:lang/pages/:id/unpublish')
  @ApiOperation({ summary: 'Снять страницу с публикации' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  unpublish(@Param('lang', LangParamPipe) _lang: Language, @Param('id') id: string): Promise<any> {
    return this.service.setStatus(id, 'draft');
  }
}
