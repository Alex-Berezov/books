import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ViewStatsService } from './view-stats.service';
import { CreateViewDto } from './dto/create-view.dto';
import {
  AggregateQueryDto,
  AggregateResponseDto,
  TopViewsQueryDto,
  TopViewsResponseDto,
} from './dto/aggregate.dto';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';

@ApiTags('view-stats')
@Controller()
export class ViewStatsController {
  constructor(private service: ViewStatsService) {}

  @Post('views')
  @UseGuards(RateLimitGuard)
  @ApiOperation({ summary: 'Record a view (anonymous or authorized)' })
  create(@Req() req: { user?: { userId: string } }, @Body() dto: CreateViewDto) {
    const userId = req.user?.userId ?? null;
    return this.service.create(userId, dto);
  }

  @Get('views/aggregate')
  @ApiOperation({ summary: 'Aggregate views by day for a version' })
  aggregate(@Query() q: AggregateQueryDto): Promise<AggregateResponseDto> {
    return this.service.aggregate(q);
  }

  @Get('views/top')
  @ApiOperation({ summary: 'Top viewed versions for a period' })
  top(@Query() q: TopViewsQueryDto): Promise<TopViewsResponseDto> {
    return this.service.top(q);
  }
}
