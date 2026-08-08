import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

describe('MetricsController', () => {
  it('returns metrics with correct content type', async () => {
    // Гварды маршрута (LEGACY-072) здесь подменяются: они тянут Reflector, JwtService
    // и Prisma, которых в этом изолированном модуле нет. Сам доступ проверяется не
    // тут, а в `test/metrics-access.e2e-spec.ts` — на поднятом приложении, где
    // анонимный запрос обязан получить 401.
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
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
