import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { LikesService } from './likes.service';
import { LikeRequestDto, LikeCountQueryDto } from './dto/like.dto';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('likes')
@Controller()
export class LikesController {
  constructor(private readonly service: LikesService) {}

  @Post('likes')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Like a comment or a book version (exactly one target)' })
  @ApiOkResponse({ description: 'Created or already exists' })
  like(
    @Req() req: { user: RequestUser },
    @Body() dto: LikeRequestDto,
  ): ReturnType<LikesService['like']> {
    return this.service.like(req.user.userId, dto);
  }

  @Delete('likes')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove like (idempotent)' })
  async unlike(@Req() req: { user: RequestUser }, @Body() dto: LikeRequestDto): Promise<void> {
    await this.service.unlike(req.user.userId, dto);
    return;
  }

  @Get('likes/count')
  @ApiOperation({ summary: 'Get like count for a target' })
  @ApiQuery({ name: 'target', required: true, enum: ['comment', 'bookVersion'] })
  @ApiQuery({ name: 'targetId', required: true })
  @ApiOkResponse({ schema: { properties: { count: { type: 'number' } } } })
  count(@Query() q: LikeCountQueryDto): Promise<{ count: number }> {
    return this.service.count(q);
  }

  @Patch('likes/toggle')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Toggle like; returns current state and count' })
  @ApiOkResponse({
    schema: { properties: { liked: { type: 'boolean' }, count: { type: 'number' } } },
  })
  toggle(
    @Req() req: { user: RequestUser },
    @Body() dto: LikeRequestDto,
  ): ReturnType<LikesService['toggle']> {
    return this.service.toggle(req.user.userId, dto);
  }
}
