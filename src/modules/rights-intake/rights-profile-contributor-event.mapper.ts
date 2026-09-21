import type { PrismaClient } from '@prisma/client';
import { parseContributorEventSnapshot } from '../../shared/rights-contributor-event/contributor-event-snapshot';
import type { RightsProfileContributorEventDto } from './dto/rights-profile-response.dto';

/**
 * `LEGACY-037`: потолок журнала связей участников в ответе профиля.
 *
 * Ответ профиля и так тяжёлый, а история привязок растёт без потолка — отдаются последние
 * события, свежие сверху. Константа одна на оба пути сборки профиля: свой лимит в дашборде
 * версии заводить нельзя, иначе два ответа об одной сущности режут историю по-разному
 * (решение арбитра 21.09.2026, `decisions-log.md`).
 */
export const CONTRIBUTOR_EVENTS_LIMIT = 200;

/** Аргументы выборки журнала — одни и те же у обоих путей. */
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
 * Единая проекция события связи участника в DTO — используется и ручкой профиля
 * (`rights-profile.service.ts`), и дашбордом версии (`book-version.service.ts`).
 *
 * Колонка `payload` наружу сырым `Json` не идёт: её содержимое раскладывается в типизированный
 * `snapshot` (решение арбитра 21.09.2026). Общая проекция здесь не украшение — до неё дашборд
 * собирал профиль своей сборкой, и поле, добавленное в ручку профиля, на второй экран
 * не доезжало вовсе.
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
