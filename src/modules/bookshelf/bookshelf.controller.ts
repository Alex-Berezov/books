import {
  Controller,
  Get,
  Param,
  Post,
  Delete,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BookshelfService } from './bookshelf.service';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { BookshelfListDto, BookshelfItemDto } from './dto/bookshelf.dto';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('bookshelf')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class BookshelfController {
  constructor(private readonly service: BookshelfService) {}

  @Get('me/bookshelf')
  @ApiOperation({ summary: 'List my bookshelf' })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiOkResponse({ type: BookshelfListDto })
  list(@Req() req: { user: RequestUser }, @Query() pagination?: PaginationDto) {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 10;
    return this.service.list(req.user.userId, page, limit);
  }

  @Post('me/bookshelf/:versionId')
  @ApiOperation({ summary: 'Add version to my bookshelf' })
  @ApiParam({ name: 'versionId' })
  @ApiCreatedResponse({ type: BookshelfItemDto })
  add(@Req() req: { user: RequestUser }, @Param('versionId') versionId: string) {
    return this.service.add(req.user.userId, versionId);
  }

  @Delete('me/bookshelf/:versionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove version from my bookshelf' })
  @ApiParam({ name: 'versionId' })
  async remove(@Req() req: { user: RequestUser }, @Param('versionId') versionId: string) {
    await this.service.remove(req.user.userId, versionId);
    return;
  }
}
