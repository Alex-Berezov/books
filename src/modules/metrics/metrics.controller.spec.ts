import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsAccessGuard } from './metrics-access.guard';

describe('MetricsController', () => {
  it('returns metrics with correct content type', async () => {
    // Гвард маршрута здесь подменяется: он тянет ConfigService и роли из Prisma,
    // которых в этом изолированном модуле нет. Сам доступ проверяется не тут, а в
    // `test/metrics-access.e2e-spec.ts` — на поднятом приложении, где анонимный
    // запрос обязан получить 401, чужой токен — 401, а незаданный `METRICS_TOKEN`
    // не должен открывать маршрут вовсе (LEGACY-072, LEGACY-095).
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService],
    })
      .overrideGuard(MetricsAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const controller = moduleRef.get(MetricsController);
    const svc = moduleRef.get(MetricsService);

    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
    } as unknown as import('express').Response;
    const body = await controller.getMetrics(res);
    expect(headers['Content-Type']).toBe(svc.contentType);
    expect(body).toContain('# HELP');
    expect(body).toContain('process_cpu_user_seconds_total');
  });
});
