import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';
import type { Response } from 'express';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  // LEGACY-072: маршрут отдавал реестр prom-client анонимно — состав маршрутов,
  // объёмы трафика и коды ответов. Закрывать его стало можно только после того,
  // как healthcheck контейнера переехал на `/api/health/liveness`
  // (docker-compose.prod.yml) и `/api/metrics` убран из проверок deploy.yml.
  //
  // 10.08.2026: доступ восстановлен для скрейпера через `METRICS_TOKEN`
  // (LEGACY-095). Прежняя запись «скрейпер предъявить токен не умеет» была
  // неточной — Prometheus умеет статический bearer; не годился именно JWT
  // с его 12 часами жизни. Подробности — в `MetricsAccessGuard`.
  @Get('metrics')
  @UseGuards(MetricsAccessGuard)
  async getMetrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.getMetrics();
  }
}
