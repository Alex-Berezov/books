import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { WorldBeaconRateLimitGuard } from '../../common/guards/world-beacon-rate-limit.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { WorldBeaconDto, WorldStatsQueryDto, WorldStatsResponseDto } from './dto/world-stats.dto';
import { WorldStatsService } from './world-stats.service';

/**
 * Счётчики публичных страниц мира книги (F08-3, `product.md` §14). Приём событий — без авторизации
 * и без cookie, лимит по адресу — гардом; отчёт — только администратору (решение арбитра
 * `F08 | F08-3` Q5).
 */
@ApiTags('world')
@Controller()
export class WorldStatsController {
  constructor(private readonly stats: WorldStatsService) {}

  @Post('world/beacon')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Count an event of a public world page (view or followed link); stores a daily aggregate only, no IP, user or cookie',
  })
  @ApiNoContentResponse({ description: 'Counted, or ignored for bots; no body' })
  @ApiBadRequestResponse({ description: 'Unknown event, malformed key or version id, extra field' })
  @ApiNotFoundResponse({ description: 'No such public world page (version or entity)' })
  @ApiTooManyRequestsResponse({ description: 'Too many events from one address; see Retry-After' })
  @UseGuards(WorldBeaconRateLimitGuard)
  beacon(
    @Body() dto: WorldBeaconDto,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<void> {
    return this.stats.record(dto, userAgent);
  }

  @Get('admin/world/stats')
  @ApiOperation({
    summary:
      'World pages report: event sums per version, entity key and event over the last N days (UTC)',
  })
  @ApiOkResponse({ type: WorldStatsResponseDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  report(@Query() query: WorldStatsQueryDto): Promise<WorldStatsResponseDto> {
    return this.stats.report(query.bookVersionId, query.days);
  }
}
