import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let service: jest.Mocked<HealthService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            liveness: jest.fn().mockReturnValue({
              status: 'up',
              uptime: 1,
              timestamp: 'now',
            }),
            readiness: jest.fn().mockResolvedValue({
              status: 'up',
              details: { prisma: 'up', redis: 'skipped' },
            }),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(HealthController);
    service = moduleRef.get(HealthService);
  });

  it('liveness returns service result', () => {
    const res = controller.liveness();
    expect(res.status).toBe('up');
    const called = (service.liveness as unknown as jest.Mock).mock.calls.length;
    expect(called).toBeGreaterThan(0);
  });

  it('readiness returns service result', async () => {
    const res = await controller.readiness();
    expect(res.status).toBe('up');
    const called = (service.readiness as unknown as jest.Mock).mock.calls.length;
    expect(called).toBeGreaterThan(0);
  });
});
