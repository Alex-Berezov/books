import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthorService } from './author.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('authors')
@ApiBearerAuth()
@Controller()
export class AuthorController {
  constructor(private readonly service: AuthorService) {}

  @Get('admin/authors/check-slug')
  @ApiOperation({ summary: 'Check slug uniqueness for an author' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query('slug') slug: string, @Query('excludeId') excludeId?: string) {
    const existing = await this.service.checkSlugExists(slug, excludeId);
    if (!existing) {
      return { exists: false };
    }
    const authorId: string = existing.authorId;
    const authorSlug: string = existing.slug;
    return {
      exists: true,
      existingAuthor: {
        id: authorId,
        slug: authorSlug,
      },
    };
  }

  /**
   * Запасные значения тут не нужны и раньше были мёртвым кодом (`LEGACY-217`):
   * глобальный `ValidationPipe` поднят с `transform: true` (`main.ts:77-83`),
   * то есть экземпляр `PaginationDto` со своими умолчаниями 1 и 10 приезжает
   * сюда уже собранным. Прежние `1` и `20` в этой строке читались как контракт
   * ручки и им не были: наружу всё это время уходила страница в десять записей.
   */
  @Get('admin/authors')
  @ApiOperation({ summary: 'List authors for admin' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  list(@Query() pagination: PaginationDto) {
    return this.service.list(pagination.page, pagination.limit);
  }

  @Post('admin/authors')
  @ApiOperation({ summary: 'Create author' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateAuthorDto) {
    return this.service.create(dto);
  }

  @Put('admin/authors/:id')
  @ApiOperation({ summary: 'Update author' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateAuthorDto) {
    return this.service.update(id, dto);
  }

  @Delete('admin/authors/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete author' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
