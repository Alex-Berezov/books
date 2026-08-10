import { ConfigService } from '@nestjs/config';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BookSummaryService } from './book-summary.service';

interface PrismaStub {
  bookVersion: { findUnique: jest.Mock };
  bookSummary: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  userRole: { findMany: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  bookVersion: { findUnique: jest.fn() },
  bookSummary: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  userRole: { findMany: jest.fn().mockResolvedValue([]) },
});

class ConfigStub {
  private store: Record<string, string> = {};
  get(key: string): string | undefined {
    return this.store[key];
  }
  set(key: string, value: string) {
    this.store[key] = value;
  }
}

describe('BookSummaryService', () => {
  let service: BookSummaryService;
  let prisma: PrismaStub;
  let config: ConfigStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    config = new ConfigStub();
    // Настоящий сервис ролей поверх тех же стабов — см. `comments.service.spec`.
    const moderatorRoles = new ModeratorRolesService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
    service = new BookSummaryService(prisma as unknown as PrismaService, moderatorRoles);
  });

  it('getByVersion throws when version not found', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue(null);
    await expect(service.getByVersion('missing')).rejects.toThrow('BookVersion not found');
  });

  it('getByVersion returns first summary', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'published' });
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });
    const res = await service.getByVersion('v1');
    expect(res?.id).toBe('s1');
  });

  /**
   * 🔴 `LEGACY-090`. Саммари черновой версии читалось анонимно по id версии.
   *
   * ⚠️ Ответ — 404, а не 403: сам факт существования черновика редакция не
   * обязана подтверждать. Ровно поэтому проверяется и то, что до выборки
   * саммари дело не доходит вовсе.
   */
  it('прячет саммари черновика от анонима', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });

    await expect(service.getByVersion('v1')).rejects.toThrow('BookVersion not found');
    expect(prisma.bookSummary.findFirst).not.toHaveBeenCalled();
  });

  // Редактор пишет саммари до публикации — фильтр без исключения для роли
  // сделал бы админскую вкладку «Summary» вечно пустой.
  it('отдаёт саммари черновика редактору', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });
    prisma.userRole.findMany.mockResolvedValue([{ role: { name: 'content_manager' } }]);
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });

    const res = await service.getByVersion('v1', { userId: 'u1', email: 'editor@site.tld' });
    expect(res?.id).toBe('s1');
  });

  // Второй источник роли — список почт в окружении, а не только связи в БД.
  it('отдаёт саммари черновика админу из ADMIN_EMAILS', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });
    config.set('ADMIN_EMAILS', 'admin@ex.com');
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });

    const res = await service.getByVersion('v1', { userId: 'u2', email: 'admin@ex.com' });
    expect(res?.id).toBe('s1');
  });

  // Вошедший ≠ редактор: обычный пользователь черновик не видит.
  it('не отдаёт саммари черновика обычному пользователю', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });

    await expect(
      service.getByVersion('v1', { userId: 'u3', email: 'reader@site.tld' }),
    ).rejects.toThrow('BookVersion not found');
  });

  it('upsertForVersion creates when missing', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    prisma.bookSummary.create.mockResolvedValue({ id: 's2', bookVersionId: 'v1', summary: 'NS' });
    const res = await service.upsertForVersion('v1', { summary: 'NS' });
    expect(res.id).toBe('s2');
    expect(prisma.bookSummary.create).toHaveBeenCalled();
  });

  it('upsertForVersion updates when exists', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });
    prisma.bookSummary.update.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'UPD' });
    const res = await service.upsertForVersion('v1', { summary: 'UPD' });
    expect(res.summary).toBe('UPD');
    expect(prisma.bookSummary.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { summary: 'UPD' },
    });
  });
});
