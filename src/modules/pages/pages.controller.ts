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
import { PagesService } from './pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { Language } from '@prisma/client';

@ApiTags('pages')
@Controller()
export class PagesController {
  constructor(private readonly service: PagesService) {}

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

  // Admin listing (with drafts)
  @Get('admin/:lang/pages')
  @ApiOperation({ summary: 'Листинг страниц (админ): draft+published' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiHeader({ name: 'X-Admin-Language', required: false, description: 'Приоритетнее языка пути' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  adminList(
    @Param('lang', LangParamPipe) lang: Language,
    @Query() pagination?: PaginationDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ): Promise<any> {
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(
    @Param('lang', LangParamPipe) lang: Language,
    @Body() dto: CreatePageDto,
    @Headers('x-admin-language') adminLangHeader?: string,
  ): Promise<any> {
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
