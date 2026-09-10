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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthorService } from './author.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { ListAuthorsQueryDto } from './dto/list-authors-query.dto';
import { CheckSlugQueryDto } from './dto/check-slug-query.dto';
import { CheckAuthorSlugResponseDto } from './dto/check-slug-response.dto';
import {
  AdminAuthorItemDto,
  AdminAuthorsListResponseDto,
  AuthorResponseDto,
} from './dto/author-response.dto';
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
  @ApiOkResponse({ type: CheckAuthorSlugResponseDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query() query: CheckSlugQueryDto): Promise<CheckAuthorSlugResponseDto> {
    const existing = await this.service.checkSlugExists(query.slug, query.lang, query.excludeId);
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
  @ApiOkResponse({ type: AdminAuthorsListResponseDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  list(@Query() pagination: ListAuthorsQueryDto) {
    return this.service.list(pagination.page, pagination.limit, undefined, pagination.q);
  }

  @Post('admin/authors')
  @ApiOperation({ summary: 'Create author' })
  @ApiCreatedResponse({ type: AuthorResponseDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Body() dto: CreateAuthorDto) {
    return this.service.create(dto);
  }

  /**
   * `check-slug` объявлен раньше как литеральный маршрут (`LEGACY-352`): без
   * этого порядка запрос на слаг ушёл бы сюда с `id: 'check-slug'`.
   */
  @Get('admin/authors/:id')
  @ApiOperation({ summary: 'Get author by id' })
  @ApiParam({ name: 'id', description: 'Author id' })
  @ApiResponse({
    status: 200,
    description: 'Author, same shape as a list item',
    type: AdminAuthorItemDto,
  })
  @ApiResponse({ status: 404, description: 'Author not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Put('admin/authors/:id')
  @ApiOperation({ summary: 'Update author' })
  @ApiOkResponse({ type: AuthorResponseDto })
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
