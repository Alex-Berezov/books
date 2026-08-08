import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { Response } from 'express';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  // LEGACY-072: маршрут отдавал реестр prom-client анонимно — состав маршрутов,
  // объёмы трафика и коды ответов. Закрывать его стало можно только после того,
  // как healthcheck контейнера переехал на `/api/health/liveness`
  // (docker-compose.prod.yml) и `/api/metrics` убран из проверок deploy.yml.
  // Скрейпер Prometheus предъявить токен не умеет — job отключён в configs/prometheus.yml.
  @Get('metrics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async getMetrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.getMetrics();
  }
}
