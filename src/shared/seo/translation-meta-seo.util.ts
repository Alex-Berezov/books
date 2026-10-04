import { Prisma } from '@prisma/client';
import { seoOwnersCount } from './seo-orphan.util';

/**
 * Meta/OG перевода тега и категории, которые публика читает только из `Seo`
 * (`seo.service.ts`, `buildSocialCards.ts`), а писатели присылают ещё и плоскими полями перевода.
 */
const TRANSLATION_META_FIELDS = [
  'metaTitle',
  'metaDescription',
  'ogTitle',
  'ogDescription',
  'ogImageUrl',
  'ogImageAlt',
] as const;

type TranslationMetaField = (typeof TRANSLATION_META_FIELDS)[number];

export type TranslationMetaInput = Partial<Record<TranslationMetaField, string | null | undefined>>;

/**
 * 🔴 `LEGACY-436`, `T100` (решение арбитра 04.10.2026): плоские meta/OG перевода переносятся в `Seo`
 * у всех писателей — сервисов тега и категории и импорта, который пишет мимо сервисов. Иначе значение,
 * записанное без вложенного `seo`, лежит в колонке, которую публичный путь не читает.
 *
 * - `seo.X` в том же запросе побеждает плоское X: плоское поле здесь не трогает `Seo.X`.
 * - Плоский `null` (и пустая строка) обнуляет `Seo.X`, но строку `Seo` не создаёт.
 * - Отвязка и удаление `Seo` — только через `seo` целиком из `null`; здесь их нет. Отвязавший
 *   запрос вызывающий сюда не передаёт: плоское поле отвязку не перебивает.
 * - Строка `Seo` с другим владельцем не трогается — правка ушла бы и ему (`LEGACY-400`, как
 *   и бэкфилл `20261004200000_legacy_436_backfill_translation_seo`).
 *
 * Работает в `tx` вызывающего, под его замком термина. Возвращает `seoId`, который должен стоять
 * у перевода: прежний или новый, если строку пришлось создать.
 */
export async function mirrorTranslationMetaToSeo(
  tx: Prisma.TransactionClient,
  seoId: number | null,
  flat: TranslationMetaInput,
  seo?: TranslationMetaInput | null,
): Promise<number | null> {
  const data: Prisma.SeoUpdateInput = {};
  let hasValue = false;
  for (const field of TRANSLATION_META_FIELDS) {
    const value = flat[field];
    if (value === undefined || seo?.[field] !== undefined) continue;
    const normalized = value === null || value.trim() === '' ? null : value;
    data[field] = normalized;
    if (normalized !== null) hasValue = true;
  }
  if (Object.keys(data).length === 0) return seoId;
  if (seoId !== null) {
    // Ноль владельцев — строку только что создал тот же запрос из `seo`, перевод её ещё не держит.
    // Замок до счёта, как в `deleteSeoIfUnreferenced`: встречная привязка строки к другому владельцу
    // встаёт в очередь, а не попадает между счётом и записью.
    await tx.$queryRaw`SELECT id FROM "Seo" WHERE id = ${seoId} FOR UPDATE`;
    const owners = await seoOwnersCount(tx, seoId);
    if (owners === null || owners > 1) return seoId;
    await tx.seo.update({ where: { id: seoId }, data });
    return seoId;
  }
  if (!hasValue) return null;
  const created = await tx.seo.create({
    data: data as Prisma.SeoCreateInput,
    select: { id: true },
  });
  return created.id;
}
