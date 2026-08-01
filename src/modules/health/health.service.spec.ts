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

  // The deploy pipeline compares this field with the tag it built; without it the check silently
  // read "unknown" on every deployment and could not tell a stale container from a fresh one.
  describe('liveness version', () => {
    const originalVersion = process.env.APP_VERSION;

    afterEach(() => {
      if (originalVersion === undefined) {
        delete process.env.APP_VERSION;
      } else {
        process.env.APP_VERSION = originalVersion;
      }
    });

    it('reports the image tag the container was started with', () => {
      process.env.APP_VERSION = 'main-b39ea21';
      expect(service.liveness().version).toBe('main-b39ea21');
    });

    it('reports unknown when the deploy passed no tag', () => {
      delete process.env.APP_VERSION;
      expect(service.liveness().version).toBe('unknown');
    });

    it('reports unknown for an empty tag rather than an empty string', () => {
      process.env.APP_VERSION = '   ';
      expect(service.liveness().version).toBe('unknown');
    });
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
