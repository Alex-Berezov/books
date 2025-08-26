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
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PagesService } from './pages.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('pages')
@Controller()
export class PagesController {
  constructor(private readonly service: PagesService) {}

  // Public: get page by slug (only published)
  @Get('pages/:slug')
  @ApiOperation({ summary: 'Публичная страница по slug (только published)' })
  @ApiParam({ name: 'slug' })
  getPublic(@Param('slug') slug: string): Promise<any> {
    return this.service.getPublicBySlug(slug);
  }

  // Admin listing (with drafts)
  @Get('admin/pages')
  @ApiOperation({ summary: 'Листинг страниц (админ): draft+published' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  adminList(@Query() pagination?: PaginationDto): Promise<any> {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 20;
    return this.service.adminList(page, limit);
  }

  @Post('admin/pages')
  @ApiOperation({ summary: 'Создать страницу (админ)' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreatePageDto): Promise<any> {
    return this.service.create(dto);
  }

  @Patch('admin/pages/:id')
  @ApiOperation({ summary: 'Обновить страницу (админ)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdatePageDto): Promise<any> {
    return this.service.update(id, dto);
  }

  @Delete('admin/pages/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Удалить страницу (админ)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string): Promise<any> {
    return this.service.remove(id);
  }

  @Patch('admin/pages/:id/publish')
  @ApiOperation({ summary: 'Опубликовать страницу' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  publish(@Param('id') id: string): Promise<any> {
    return this.service.setStatus(id, 'published');
  }

  @Patch('admin/pages/:id/unpublish')
  @ApiOperation({ summary: 'Снять страницу с публикации' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  unpublish(@Param('id') id: string): Promise<any> {
    return this.service.setStatus(id, 'draft');
  }
}
