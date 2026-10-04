import { Prisma } from '@prisma/client';

/**
 * Все владельцы строки `Seo` — обратные связи модели `Seo` в схеме. Сверяются со схемой через
 * `Prisma.dmmf` (`seo-orphan.util.spec.ts`): седьмой владелец, не попавший сюда, дал бы удаление
 * `Seo` из-под живой сущности.
 */
export const SEO_OWNER_RELATIONS = [
  'bookVersion',
  'page',
  'categoryTranslation',
  'tagTranslation',
  'authorTranslation',
  'personTranslation',
] as const satisfies readonly (keyof Prisma.SeoSelect)[];

type SeoOwnerRelation = (typeof SEO_OWNER_RELATIONS)[number];

/**
 * Сколько сущностей держат строку `Seo`; `null` — строки нет.
 *
 * ⚠️ `@unique` на `seoId` стоит у каждого владельца, но только внутри своей таблицы: схема не запрещает
 * одной строке `Seo` принадлежать, скажем, странице и переводу категории сразу. Поэтому «отвязали от меня —
 * значит ничья» неверно, и удалять строку можно только после счёта всех шести владельцев (`LEGACY-400`).
 */
export async function seoOwnersCount(
  tx: Prisma.TransactionClient,
  seoId: number,
): Promise<number | null> {
  const select = Object.fromEntries(
    SEO_OWNER_RELATIONS.map((relation) => [relation, { select: { id: true } }]),
  ) as Record<SeoOwnerRelation, { select: { id: true } }>;
  const seo: Record<string, unknown> | null = await tx.seo.findUnique({
    where: { id: seoId },
    select,
  });
  if (!seo) return null;
  return Object.values(seo).filter((owner) => owner !== null).length;
}

/**
 * Запирает строку `Seo` (`FOR UPDATE`) и считает её владельцев; `null` — строки нет.
 * Замок до счёта: привязка (`FOR KEY SHARE` проверки внешнего ключа) встаёт в очередь и не попадает
 * между счётом и тем, что вызывающий делает со строкой дальше (удаление, запись). Звать в `tx`
 * вызывающего под его замком владельца: порядок «строка владельца → `Seo`» (`LEGACY-400`, `LEGACY-436`).
 */
export async function lockSeoAndCountOwners(
  tx: Prisma.TransactionClient,
  seoId: number,
): Promise<number | null> {
  await tx.$queryRaw`SELECT id FROM "Seo" WHERE id = ${seoId} FOR UPDATE`;
  return seoOwnersCount(tx, seoId);
}

/**
 * Удаляет строку `Seo`, если её больше никто не держит. Зовётся **после** того, как владелец её отпустил
 * (отвязка, удаление), тем же `tx` — иначе сирота переживает откат или удаляется из-под живого владельца.
 * Сирота не безобидна: её адресные колонки держат медиа от уборки (`LEGACY-413`).
 *
 * Порядок замков повторён в `prisma/scripts/cleanup-duplicate-book-versions.ts` (`deleteVersionsWithSeo`):
 * скрипт идёт в образ без `src/` и этот файл импортировать не может. Меняешь порядок здесь — правь и там.
 */
export async function deleteSeoIfUnreferenced(
  tx: Prisma.TransactionClient,
  seoId: number | null | undefined,
): Promise<void> {
  if (!seoId) return;
  // Встречная привязка после удаления получает `P2003`, а не ссылку на удалённую строку. Без замка
  // она, закоммиченная между счётом и удалением, теряла бы `seoId` через SetNull.
  if ((await lockSeoAndCountOwners(tx, seoId)) !== 0) return;
  await tx.seo.deleteMany({ where: { id: seoId } });
}
