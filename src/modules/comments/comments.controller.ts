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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ListCommentsQueryDto } from './dto/list-comments.dto';
import { CommentListDto } from './dto/comment-list.dto';
import { CommentDto } from './dto/comment.dto';
import { AdminCommentsQueryDto, AdminCommentsResponseDto } from './dto/admin-comments.dto';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('comments')
@Controller()
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get('comments')
  @ApiOperation({ summary: 'List comments by target' })
  @ApiQuery({ name: 'target', required: true, enum: ['version', 'chapter', 'audio'] })
  @ApiQuery({ name: 'targetId', required: true })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['date', 'popularity'] })
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiOkResponse({ type: CommentListDto })
  list(@Query() q: ListCommentsQueryDto) {
    const { target, targetId, sortBy = 'date', page = 1, limit = 10 } = q;
    return this.service.list({ target, targetId, sortBy, page, limit });
  }

  /**
   * Список всех комментариев сайта для модерации (`LEGACY-092`).
   *
   * ⚠️ Отдельный маршрут, а не параметры к публичному `GET /comments`: тот
   * отвечает на вопрос «что показать под этой книгой» и обязан требовать
   * `target`/`targetId`. Смешение двух вопросов в одном маршруте — ровно то,
   * что пришлось расплетать в `LEGACY-093`.
   */
  @Get('admin/comments')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'List all comments for moderation (admin)' })
  @ApiOkResponse({ type: AdminCommentsResponseDto })
  adminList(@Query() query: AdminCommentsQueryDto): Promise<AdminCommentsResponseDto> {
    return this.service.adminList({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      search: query.search,
      status: query.status,
      bookId: query.bookId,
    });
  }

  @Post('comments')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @ApiOperation({ summary: 'Create comment' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @ApiOkResponse({ type: CommentDto })
  create(@Req() req: { user: RequestUser }, @Body() dto: CreateCommentDto) {
    return this.service.create(req.user.userId, dto);
  }

  /**
   * Токен здесь необязателен, но меняет ответ: скрытый комментарий видит только
   * модератор (`LEGACY-089`).
   */
  @Get('comments/:id')
  @ApiBearerAuth()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get comment (hidden ones are visible to moderators only)' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: CommentDto })
  get(@Param('id') id: string, @Req() req?: { user?: RequestUser }) {
    return this.service.get(id, req?.user);
  }

  @Patch('comments/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @ApiOperation({
    summary: 'Update comment (owner can edit text; admins/moderators can also hide/unhide)',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  @ApiOkResponse({ type: CommentDto })
  update(
    @Req() req: { user: RequestUser },
    @Param('id') id: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.service.update(id, req.user, dto);
  }

  @Delete('comments/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete (soft) comment. Owner or admin/content_manager.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded' })
  async remove(@Req() req: { user: RequestUser }, @Param('id') id: string) {
    await this.service.remove(id, req.user);
    return;
  }
}
