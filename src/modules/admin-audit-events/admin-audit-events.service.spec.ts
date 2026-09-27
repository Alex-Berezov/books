import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminAuditAction, AdminAuditTargetType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditEventsService } from './admin-audit-events.service';
import { ListAdminAuditEventsQueryDto } from './dto/list-admin-audit-events-query.dto';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const queryOf = (plain: Record<string, unknown>): ListAdminAuditEventsQueryDto =>
  plainToInstance(ListAdminAuditEventsQueryDto, plain);

const errorsOf = (plain: Record<string, unknown>): string[] =>
  validateSync(queryOf(plain)).map((e) => e.property);

describe('ListAdminAuditEventsQueryDto (LEGACY-015 пункт 3)', () => {
  it('targetId без targetType — ошибка на targetType', () => {
    expect(errorsOf({ targetId: USER_ID })).toEqual(['targetType']);
  });

  it('пара targetType+targetId проходит', () => {
    expect(errorsOf({ targetType: 'USER', targetId: USER_ID })).toEqual([]);
  });

  it('без фильтров проходит, targetType один — тоже', () => {
    expect(errorsOf({})).toEqual([]);
    expect(errorsOf({ targetType: 'BOOK' })).toEqual([]);
  });

  it('from/to — только дата-время с зоной', () => {
    expect(errorsOf({ from: '2026-09-27T00:00:00Z', to: '2026-09-27T23:59:59.999+03:00' })).toEqual(
      [],
    );
    expect(errorsOf({ to: '2026-09-27' })).toEqual(['to']);
    expect(errorsOf({ from: '2026-09-27T10:00' })).toEqual(['from']);
    expect(errorsOf({ to: '2026-02-30T00:00:00Z' })).toEqual(['to']);
    expect(errorsOf({ from: '0000-01-01T00:00:00Z' })).toEqual(['from']);
    expect(
      errorsOf({ from: '2026-09-27T00:00:00+0300', to: '2026-09-27T23:59:59.999999Z' }),
    ).toEqual([]);
  });

  it('limit выше потолка и нечисловой page отвергаются', () => {
    expect(errorsOf({ limit: '101' })).toEqual(['limit']);
    expect(errorsOf({ page: 'x' })).toEqual(['page']);
  });
});

describe('AdminAuditEventsService.list', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const prisma = {
    adminAuditEvent: { findMany, count },
    $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
  } as unknown as PrismaService;
  const service = new AdminAuditEventsService(prisma);

  beforeEach(() => {
    findMany.mockClear();
    count.mockClear();
  });

  it('собирает where из всех фильтров и отдаёт общую форму списка', async () => {
    const result = await service.list(
      queryOf({
        page: 2,
        limit: 5,
        targetType: AdminAuditTargetType.USER,
        targetId: USER_ID,
        actorUserId: USER_ID,
        action: AdminAuditAction.ROLE_ASSIGNED,
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T00:00:00.000Z',
      }),
    );

    const where = {
      targetType: AdminAuditTargetType.USER,
      targetId: USER_ID,
      actorUserId: USER_ID,
      action: AdminAuditAction.ROLE_ASSIGNED,
      createdAt: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-30T00:00:00.000Z'),
      },
    };
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 5,
        take: 5,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where });
    expect(result).toEqual({
      items: [],
      pagination: { page: 2, limit: 5, total: 0, totalPages: 0 },
    });
  });

  it('без фильтров where пуст, createdAt не подставляется, страница по умолчанию 20', async () => {
    await service.list(queryOf({}));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {}, skip: 0, take: 20 }),
    );
  });

  it('from позже to — 400 до запроса в базу', async () => {
    await expect(
      service.list(queryOf({ from: '2026-09-28T00:00:00Z', to: '2026-09-27T00:00:00Z' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('отдаёт ровно поля строки журнала — без подклейки актёра', async () => {
    await service.list(queryOf({}));
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as {
      select: Record<string, boolean>;
      include?: unknown;
    };
    expect(Object.keys(args.select).sort()).toEqual(
      ['action', 'actorUserId', 'createdAt', 'id', 'payload', 'targetId', 'targetType'].sort(),
    );
    expect(args.include).toBeUndefined();
  });
});
