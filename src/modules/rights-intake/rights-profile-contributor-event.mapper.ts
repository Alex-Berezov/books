import type { PrismaClient } from '@prisma/client';
import { parseContributorEventSnapshot } from '../../shared/rights-contributor-event/contributor-event-snapshot';
import type { RightsProfileContributorEventDto } from './dto/rights-profile-response.dto';

/**
 * `LEGACY-037`: потолок журнала связей участников в ответе профиля.
 *
 * Ответ профиля и так тяжёлый, а история привязок растёт без потолка — отдаются последние
 * события, свежие сверху. С 26.09.2026 (`LEGACY-412`) путь сборки профиля один: дашборд версии
 * зовёт `RightsProfileService.getById`, своей выборки журнала у него нет и заводить её нельзя.
 */
export const CONTRIBUTOR_EVENTS_LIMIT = 200;

/** Аргументы выборки журнала. */
export const contributorEventsQuery = (rightsProfileId: string) =>
  ({
    where: { rightsProfileId },
    orderBy: { createdAt: 'desc' },
    take: CONTRIBUTOR_EVENTS_LIMIT,
  }) as const;

/** Одна строка журнала, как её отдаёт Prisma. */
export type RightsProfileContributorEventRecord = Awaited<
  ReturnType<PrismaClient['rightsProfileContributorEvent']['findMany']>
>[number];

/**
 * Проекция события связи участника в DTO для `RightsProfileService.mapToDetail` — единственной
 * сборки профиля (дашборд версии получает её через `getById`, `LEGACY-412`).
 *
 * Колонка `payload` наружу сырым `Json` не идёт: её содержимое раскладывается в типизированный
 * `snapshot` (решение арбитра 21.09.2026).
 */
export const mapContributorEvent = (
  record: RightsProfileContributorEventRecord,
): RightsProfileContributorEventDto => ({
  id: record.id,
  eventType: record.eventType,
  rightsProfileContributorId: record.rightsProfileContributorId,
  rightsComponentId: record.rightsComponentId ?? null,
  sourceEditionId: record.sourceEditionId ?? null,
  personId: record.personId ?? null,
  role: record.role ?? null,
  displayName: record.displayName ?? null,
  creditedName: record.creditedName ?? null,
  snapshot: parseContributorEventSnapshot(record.payload),
  createdByUserId: record.createdByUserId ?? null,
  createdAt: record.createdAt.toISOString(),
});

/** Загрузка и проекция одним вызовом — чтобы оба пути не повторяли аргументы выборки. */
export const loadContributorEvents = async (
  prisma: Pick<PrismaClient, 'rightsProfileContributorEvent'>,
  rightsProfileId: string,
): Promise<RightsProfileContributorEventDto[]> => {
  const rows = await prisma.rightsProfileContributorEvent.findMany(
    contributorEventsQuery(rightsProfileId),
  );
  return rows.map(mapContributorEvent);
};
