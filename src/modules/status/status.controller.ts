import { Controller, Get, UseGuards, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { RateLimitConfigDto } from './dto/rate-limit-config.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(private readonly config: ConfigService) {}

  @Get('rate-limit')
  @ApiOperation({ summary: 'Rate limit configuration' })
  @ApiOkResponse({ type: RateLimitConfigDto })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  getRateLimit(): RateLimitConfigDto {
    const enabled = this.config.get('RATE_LIMIT_ENABLED') === '1';
    const windowMsRaw = this.config.get<string>('RATE_LIMIT_COMMENTS_WINDOW_MS');
    const maxRaw = this.config.get<string>('RATE_LIMIT_COMMENTS_PER_MINUTE');
    const windowMs = windowMsRaw && Number(windowMsRaw) > 0 ? Number(windowMsRaw) : 60_000;
    const maxPoints = maxRaw && Number(maxRaw) > 0 ? Number(maxRaw) : 10;
    return {
      enabled,
      windowMs,
      maxPoints,
      driver: 'inmemory',
      scope: 'userId|ip',
      endpoints: ['POST /comments', 'PATCH /comments/:id', 'DELETE /comments/:id'],
    };
  }

  @Post('sentry-test')
  @ApiOperation({ summary: 'Сгенерировать тестовую ошибку для проверки интеграции Sentry' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  sentryTest(): never {
    throw new Error('Sentry test error (manual trigger)');
  }
}
