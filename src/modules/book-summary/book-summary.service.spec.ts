import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BookSummaryService } from './book-summary.service';

interface SummaryDelegate {
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
}

interface TxStub {
  $queryRaw: jest.Mock;
  bookSummary: SummaryDelegate;
}

interface PrismaStub {
  $transaction: jest.Mock;
  bookVersion: { findUnique: jest.Mock };
  bookSummary: SummaryDelegate;
  userRole: { findMany: jest.Mock };
}

const summaryDelegate = (): SummaryDelegate => ({
  findFirst: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
});

const createTxStub = (): TxStub => ({
  $queryRaw: jest.fn().mockResolvedValue([]),
  bookSummary: summaryDelegate(),
});

// `tx` — отдельный объект, а не сам `prisma`: запись мимо `tx` иначе прошла бы незамеченной (`L-016`).
const createPrismaStub = (tx: TxStub): PrismaStub => ({
  $transaction: jest.fn((cb: (client: TxStub) => unknown) => cb(tx)),
  bookVersion: { findUnique: jest.fn() },
  bookSummary: summaryDelegate(),
  userRole: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('BookSummaryService', () => {
  let service: BookSummaryService;
  let prisma: PrismaStub;
  let tx: TxStub;

  beforeEach(() => {
    tx = createTxStub();
    prisma = createPrismaStub(tx);
    // Настоящий сервис ролей поверх тех же стабов — см. `comments.service.spec`.
    const moderatorRoles = new ModeratorRolesService(prisma as unknown as PrismaService);
    service = new BookSummaryService(prisma as unknown as PrismaService, moderatorRoles);
  });

  // Сторож `LEGACY-170` выставляет список почт; снимать его надо здесь, иначе
  // упавшее ожидание унесёт переменную в остальные файлы воркера.
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
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

  // `LEGACY-420`: пока старые дубли не вычищены, чтение и запись выбирают одну и ту же строку.
  it('getByVersion и upsertForVersion берут одну и ту же строку из дублей', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'published' });
    prisma.bookSummary.findFirst.mockResolvedValue(null);
    tx.bookSummary.findFirst.mockResolvedValue(null);
    tx.bookSummary.create.mockResolvedValue({ id: 's1' });

    await service.getByVersion('v1');
    await service.upsertForVersion('v1', { summary: 'A' });

    const readArgs = prisma.bookSummary.findFirst.mock.calls[0][0] as { orderBy: unknown };
    const writeArgs = tx.bookSummary.findFirst.mock.calls[0][0] as { orderBy: unknown };
    expect(readArgs.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
    expect(writeArgs.orderBy).toEqual(readArgs.orderBy);
  });

  it('upsertForVersion: сводку снял каскад удаления версии — P2025 читается как 404', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    tx.bookSummary.findFirst.mockResolvedValue({ id: 's1' });
    tx.bookSummary.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' }),
    );
    await expect(service.upsertForVersion('v1', { summary: 'A' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('upsertForVersion: версия удалена в окне гонки — P2003 читается как 404', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    tx.bookSummary.findFirst.mockResolvedValue(null);
    tx.bookSummary.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }),
    );
    await expect(service.upsertForVersion('v1', { summary: 'A' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
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

  // 🔴 Сторож `LEGACY-170`: источник роли один — связи в БД. Почта в
  // `ADMIN_EMAILS` черновик не открывает.
  it('не отдаёт саммари черновика по одной лишь почте из ADMIN_EMAILS', async () => {
    process.env.ADMIN_EMAILS = 'admin@ex.com';
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', status: 'draft' });
    prisma.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1', summary: 'S' });

    await expect(
      service.getByVersion('v1', { userId: 'u2', email: 'admin@ex.com' }),
    ).rejects.toThrow('BookVersion not found');
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
    tx.bookSummary.findFirst.mockResolvedValue(null);
    tx.bookSummary.create.mockResolvedValue({
      id: 's2',
      bookVersionId: 'v1',
      summary: 'NS',
    });
    const res = await service.upsertForVersion('v1', { summary: 'NS' });
    expect(res.id).toBe('s2');
    expect(tx.bookSummary.create).toHaveBeenCalledTimes(1);
    expect(tx.bookSummary.create).toHaveBeenCalledWith({
      data: { bookVersionId: 'v1', summary: 'NS' },
    });
    expect(tx.bookSummary.update).not.toHaveBeenCalled();
  });

  it('upsertForVersion updates when exists', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    tx.bookSummary.findFirst.mockResolvedValue({ id: 's1', bookVersionId: 'v1' });
    tx.bookSummary.update.mockResolvedValue({
      id: 's1',
      bookVersionId: 'v1',
      summary: 'UPD',
    });
    const res = await service.upsertForVersion('v1', { summary: 'UPD' });
    expect(res.summary).toBe('UPD');
    expect(tx.bookSummary.update).toHaveBeenCalledTimes(1);
    expect(tx.bookSummary.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { summary: 'UPD' },
    });
    expect(tx.bookSummary.create).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-420`, посадка. Раньше чтение и запись шли на пуле без замка: два
   * параллельных сохранения обе видели пустой `findFirst` и обе звали `create`.
   * Теперь первым оператором транзакции берётся advisory-замок по версии,
   * и всё чтение-запись идёт через `tx`, а не через клиент пула.
   * Саму гонку держит e2e `test/book-summary.e2e-spec.ts` — мок её не воспроизводит.
   */
  it('берёт замок версии первым оператором транзакции и пишет только через tx', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1' });
    tx.bookSummary.findFirst.mockResolvedValue(null);
    tx.bookSummary.create.mockResolvedValue({ id: 's1' });

    await service.upsertForVersion('v1', { summary: 'A' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, namespace, versionId] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      number,
      string,
    ];
    expect(sql.join('?')).toContain('pg_advisory_xact_lock');
    expect(typeof namespace).toBe('number');
    expect(versionId).toBe('v1');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.bookSummary.findFirst.mock.invocationCallOrder[0],
    );
    expect(prisma.bookSummary.findFirst).not.toHaveBeenCalled();
    expect(prisma.bookSummary.create).not.toHaveBeenCalled();
  });
});
