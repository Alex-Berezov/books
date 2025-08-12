import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Language, BookType } from '@prisma/client';

@ApiTags('book-versions')
@Controller()
export class BookVersionController {
  constructor(private readonly service: BookVersionService) {}

  @Get('books/:bookId/versions')
  @ApiOperation({ summary: 'List versions for a book' })
  @ApiParam({ name: 'bookId' })
  @ApiQuery({ name: 'language', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'isFree', required: false, schema: { type: 'boolean' } })
  list(
    @Param('bookId') bookId: string,
    @Query('language') language?: string,
    @Query('type') type?: string,
    @Query('isFree') isFree?: string,
  ) {
    const langEnum =
      language && Object.values(Language).includes(language as Language)
        ? (language as Language)
        : undefined;
    const typeEnum =
      type && Object.values(BookType).includes(type as BookType) ? (type as BookType) : undefined;
    return this.service.list(bookId, {
      language: langEnum,
      type: typeEnum,
      isFree: isFree !== undefined ? isFree === 'true' : undefined,
    });
  }

  @Post('books/:bookId/versions')
  @ApiOperation({ summary: 'Create book version' })
  @ApiParam({ name: 'bookId' })
  @ApiResponse({ status: 201, description: 'Created' })
  create(@Param('bookId') bookId: string, @Body() dto: CreateBookVersionDto) {
    return this.service.create(bookId, dto);
  }

  @Get('versions/:id')
  @ApiOperation({ summary: 'Get version by id' })
  @ApiParam({ name: 'id' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch('versions/:id')
  @ApiOperation({ summary: 'Update version by id' })
  update(@Param('id') id: string, @Body() dto: UpdateBookVersionDto) {
    return this.service.update(id, dto);
  }

  @Delete('versions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete version by id' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
