import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  HttpException,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { BookService } from './book.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { SLUG_PATTERN } from '../../shared/validators/slug';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('books')
@Controller('books')
export class BookController {
  constructor(private readonly bookService: BookService) {}

  @Post()
  @ApiOperation({ summary: 'Create new book' })
  @ApiResponse({ status: 201, description: 'Book successfully created' })
  @ApiResponse({ status: 400, description: 'Invalid data format' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async create(@Body() createBookDto: CreateBookDto) {
    try {
      return await this.bookService.create(createBookDto);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to create book', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':slug/overview')
  @ApiOperation({
    summary: 'Get book overview by slug',
    description:
      'Агрегированный обзор книги: доступные языки, наличие текста/аудио/пересказа, ID версий и SEO-бандл. Публично показывает только опубликованные версии.',
  })
  @ApiParam({ name: 'slug', description: 'Unique book slug' })
  @ApiQuery({ name: 'lang', required: false, description: 'Запрошенный язык (en|es|fr|pt)' })
  @ApiResponse({ status: 200, description: 'Overview returned' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  async overview(@Param('slug') slug: string, @Query('lang') lang?: string) {
    try {
      return await this.bookService.getOverview(slug, lang);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to get book overview', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get all books with pagination' })
  @ApiResponse({ status: 200, description: 'Books list successfully retrieved' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findAll(@Query() paginationDto: PaginationDto) {
    try {
      return await this.bookService.findAll(paginationDto);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to retrieve books list', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get book by slug' })
  @ApiParam({
    name: 'slug',
    description: 'Unique book slug',
    schema: { type: 'string', pattern: SLUG_PATTERN },
    example: 'harry-potter',
  })
  @ApiResponse({ status: 200, description: 'Book found' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findBySlug(@Param('slug') slug: string) {
    try {
      return await this.bookService.findBySlug(slug);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to get book by slug', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get book by ID' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book found' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async findOne(@Param('id') id: string) {
    try {
      return await this.bookService.findOne(id);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to get book', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book successfully updated' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async update(@Param('id') id: string, @Body() updateBookDto: UpdateBookDto) {
    try {
      return await this.bookService.update(id, updateBookDto);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to update book', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete book' })
  @ApiParam({ name: 'id', description: 'Unique book ID' })
  @ApiResponse({ status: 200, description: 'Book successfully deleted' })
  @ApiResponse({ status: 404, description: 'Book not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async remove(@Param('id') id: string) {
    try {
      await this.bookService.remove(id);
      return { success: true };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: 'Failed to delete book', details: (err as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
