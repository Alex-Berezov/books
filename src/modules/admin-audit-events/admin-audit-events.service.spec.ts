import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { AdminAuditAction, AdminAuditTargetType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAuditEventsService } from './admin-audit-events.service';
import { ListAdminAuditEventsQueryDto } from './dto/list-admin-audit-events-query.dto';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const queryOf = (plain: Record<string, unknown>): ListAdminAuditEventsQueryDto =>
  plainToInstance(ListAdminAuditEventsQueryDto, plain);

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
