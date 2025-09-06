import { HealthService, RedisProbe } from './health.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('HealthService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let redis: jest.Mocked<RedisProbe>;
  let service: HealthService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(),
    } as unknown as jest.Mocked<PrismaService>;

    redis = {
      isConfigured: jest.fn(),
      ping: jest.fn(),
    } as unknown as jest.Mocked<RedisProbe>;

    service = new HealthService(prisma, redis);
  });

  it('liveness returns up with uptime and timestamp', () => {
    const res = service.liveness();
    expect(res.status).toBe('up');
    expect(typeof res.uptime).toBe('number');
    expect(typeof res.timestamp).toBe('string');
  });

  it('readiness up when prisma ok and redis configured+ok', async () => {
    prisma.$queryRaw.mockResolvedValueOnce(1 as any);
    redis.isConfigured.mockReturnValue(true);
    redis.ping.mockResolvedValue(true);

    const res = await service.readiness();
    expect(res.status).toBe('up');
    expect(res.details.prisma).toBe('up');
    expect(res.details.redis).toBe('up');
  });

  it('readiness up when prisma ok and redis not configured (skipped)', async () => {
    prisma.$queryRaw.mockResolvedValueOnce(1 as any);
    redis.isConfigured.mockReturnValue(false);

    const res = await service.readiness();
    expect(res.status).toBe('up');
    expect(res.details.prisma).toBe('up');
    expect(res.details.redis).toBe('skipped');
  });

  it('readiness down when prisma fails', async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    redis.isConfigured.mockReturnValue(false);

    const res = await service.readiness();
    expect(res.status).toBe('down');
    expect(res.details.prisma).toBe('down');
  });

  it('readiness down when redis configured but ping fails', async () => {
    prisma.$queryRaw.mockResolvedValueOnce(1 as any);
    redis.isConfigured.mockReturnValue(true);
    redis.ping.mockResolvedValue(false);

    const res = await service.readiness();
    expect(res.status).toBe('down');
    expect(res.details.prisma).toBe('up');
    expect(res.details.redis).toBe('down');
  });

  it('readiness down when redis configured but ping throws', async () => {
    prisma.$queryRaw.mockResolvedValueOnce(1 as any);
    redis.isConfigured.mockReturnValue(true);
    redis.ping.mockRejectedValue(new Error('redis down'));

    const res = await service.readiness();
    expect(res.status).toBe('down');
    expect(res.details.prisma).toBe('up');
    expect(res.details.redis).toBe('down');
  });
});
