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
} from '@nestjs/swagger';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ListCommentsQueryDto } from './dto/list-comments.dto';
import { CommentListDto } from './dto/comment-list.dto';
import { CommentDto } from './dto/comment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
// RolesGuard not required; owner-or-moderator checks are inside service

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
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1 } })
  @ApiOkResponse({ type: CommentListDto })
  list(@Query() q: ListCommentsQueryDto) {
    const { target, targetId, page = 1, limit = 10 } = q;
    return this.service.list({ target, targetId, page, limit });
  }

  @Post('comments')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create comment' })
  @ApiOkResponse({ type: CommentDto })
  create(@Req() req: { user: RequestUser }, @Body() dto: CreateCommentDto) {
    return this.service.create(req.user.userId, dto);
  }

  @Get('comments/:id')
  @ApiOperation({ summary: 'Get comment' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: CommentDto })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch('comments/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Update comment (owner can edit text; admins/moderators can also hide/unhide)',
  })
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
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete (soft) comment. Owner or admin/content_manager.' })
  async remove(@Req() req: { user: RequestUser }, @Param('id') id: string) {
    await this.service.remove(id, req.user);
    return;
  }
}
