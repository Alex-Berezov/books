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
  @ApiOperation({ summary: 'List audio chapters by book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  list(@Param('bookVersionId') bookVersionId: string, @Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 10;
    return this.service.listByVersion(bookVersionId, page, limit);
  }

  @Post('versions/:bookVersionId/audio-chapters')
  @ApiOperation({ summary: 'Create audio chapter for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiResponse({ status: 201, description: 'Created' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  create(@Param('bookVersionId') bookVersionId: string, @Body() dto: CreateAudioChapterDto) {
    return this.service.create(bookVersionId, dto);
  }

  @Get('audio-chapters/:id')
  @ApiOperation({ summary: 'Get audio chapter by id' })
  @ApiParam({ name: 'id' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch('audio-chapters/:id')
  @ApiOperation({ summary: 'Update audio chapter by id' })
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
