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
import { CategoryService } from './category.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { AttachCategoryDto } from './dto/attach-category.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

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

  @Get('categories/:slug/books')
  @ApiOperation({ summary: 'Get book versions by category slug' })
  @ApiParam({ name: 'slug' })
  versionsByCategory(@Param('slug') slug: string) {
    return this.service.getBySlugWithBooks(slug);
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
