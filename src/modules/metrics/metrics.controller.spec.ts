import { Test } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('returns metrics with correct content type', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService],
    }).compile();

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
