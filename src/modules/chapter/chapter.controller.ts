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
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ChapterService } from './chapter.service';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { UpdateChapterDto } from './dto/update-chapter.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { Query } from '@nestjs/common';

@ApiTags('chapters')
@Controller()
export class ChapterController {
  constructor(private readonly service: ChapterService) {}

  @Get('versions/:bookVersionId/chapters')
  @ApiOperation({ summary: 'List chapters by book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  list(@Param('bookVersionId') bookVersionId: string, @Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 10;
    return this.service.listByVersion(bookVersionId, page, limit);
  }

  @Post('versions/:bookVersionId/chapters')
  @ApiOperation({ summary: 'Create chapter for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiResponse({ status: 201, description: 'Created' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Param('bookVersionId') bookVersionId: string, @Body() dto: CreateChapterDto) {
    return this.service.create(bookVersionId, dto);
  }

  @Get('chapters/:id')
  @ApiOperation({ summary: 'Get chapter by id' })
  @ApiParam({ name: 'id' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch('chapters/:id')
  @ApiOperation({ summary: 'Update chapter by id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateChapterDto) {
    return this.service.update(id, dto);
  }

  @Delete('chapters/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete chapter by id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
