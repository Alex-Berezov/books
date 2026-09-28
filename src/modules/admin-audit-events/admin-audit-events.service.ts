import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginated, type PaginatedResult } from '../../shared/dto/paginated-response.dto';
import { AdminAuditEventResponseDto } from './dto/admin-audit-event-response.dto';
import { ListAdminAuditEventsQueryDto } from './dto/list-admin-audit-events-query.dto';

/** Читатель журнала административных действий (`LEGACY-015` пункт 3). Только чтение. */
@Injectable()
export class AdminAuditEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ListAdminAuditEventsQueryDto,
  ): Promise<PaginatedResult<AdminAuditEventResponseDto>> {
    const { page, limit } = query;
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(query.from);
    if (query.to) createdAt.lte = new Date(query.to);
    if (createdAt.gte && createdAt.lte && createdAt.gte > createdAt.lte) {
      throw new BadRequestException('from must not be later than to');
    }

    const where: Prisma.AdminAuditEventWhereInput = {
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to ? { createdAt } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.adminAuditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          actorUserId: true,
          action: true,
          targetType: true,
          targetId: true,
          payload: true,
          createdAt: true,
        },
      }),
      this.prisma.adminAuditEvent.count({ where }),
    ]);

    // Prisma отдаёт `JsonValue` при любом типе записи; объектную форму гарантирует
    // `Prisma.InputJsonObject` у `AdminAuditService.record` — единственного писателя журнала в `src`
    // (сторож `admin-audit-writers.spec.ts`); сид, скрипты и миграции строк журнала не пишут.
    const rows = items.map((row) => ({
      ...row,
      payload: row.payload as Record<string, unknown> | null,
    }));
    return paginated(rows, { page, limit, total });
  }
}
