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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AudioChapterService } from './audio-chapter.service';
import { CreateAudioChapterDto } from './dto/create-audio-chapter.dto';
import { UpdateAudioChapterDto } from './dto/update-audio-chapter.dto';
import { ReorderAudioChaptersDto } from './dto/reorder-audio-chapters.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { Query } from '@nestjs/common';

@ApiTags('audio-chapters')
@Controller()
export class AudioChapterController {
  constructor(private readonly service: AudioChapterService) {}

  @Get('versions/:bookVersionId/audio-chapters')
  @ApiOperation({ summary: 'List audio chapters by book version (public, published only)' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  })
  list(@Param('bookVersionId') bookVersionId: string, @Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 50;
    return this.service.listPublic(bookVersionId, page, limit);
  }

  @Get('admin/versions/:bookVersionId/audio-chapters')
  @ApiOperation({
    summary: 'Admin: list audio chapters by book version (any status, including drafts)',
  })
  @ApiParam({ name: 'bookVersionId' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100 },
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  listAdmin(@Param('bookVersionId') bookVersionId: string, @Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 50;
    return this.service.listAdmin(bookVersionId, page, limit);
  }

  @Post('versions/:bookVersionId/audio-chapters')
  @ApiOperation({ summary: 'Create audio chapter for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 409, description: 'Audio chapter number already exists' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Param('bookVersionId') bookVersionId: string, @Body() dto: CreateAudioChapterDto) {
    return this.service.create(bookVersionId, dto);
  }

  @Post('versions/:bookVersionId/audio-chapters/reorder')
  @ApiOperation({ summary: 'Reorder audio chapters atomically by id list (1-based numbering)' })
  @ApiParam({ name: 'bookVersionId' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  reorder(@Param('bookVersionId') bookVersionId: string, @Body() dto: ReorderAudioChaptersDto) {
    return this.service.reorder(bookVersionId, dto.audioChapterIds);
  }

  @Get('audio-chapters/:id')
  @ApiOperation({ summary: 'Get audio chapter by id (public, published version only)' })
  @ApiParam({ name: 'id' })
  get(@Param('id') id: string) {
    return this.service.getPublic(id);
  }

  @Get('admin/audio-chapters/:id')
  @ApiOperation({ summary: 'Admin: get audio chapter by id (any status)' })
  @ApiParam({ name: 'id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  getAdmin(@Param('id') id: string) {
    return this.service.getAdmin(id);
  }

  @Patch('audio-chapters/:id')
  @ApiOperation({ summary: 'Update audio chapter by id' })
  @ApiResponse({ status: 409, description: 'Audio chapter number already exists' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  update(@Param('id') id: string, @Body() dto: UpdateAudioChapterDto) {
    return this.service.update(id, dto);
  }

  @Delete('audio-chapters/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete audio chapter by id' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
