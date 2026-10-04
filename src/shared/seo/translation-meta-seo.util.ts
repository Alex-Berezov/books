import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockSeoAndCountOwners } from './seo-orphan.util';

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

/** Плоские meta/OG, которые уйдут в `Seo`: `seo.X` того же запроса побеждает, пустая строка — `null`. */
function flatMetaForSeo(
  flat: TranslationMetaInput,
  seo?: TranslationMetaInput | null,
): Partial<Record<TranslationMetaField, string | null>> {
  const data: Partial<Record<TranslationMetaField, string | null>> = {};
  for (const field of TRANSLATION_META_FIELDS) {
    const value = flat[field];
    if (value === undefined || seo?.[field] !== undefined) continue;
    data[field] = value === null || value.trim() === '' ? null : value;
  }
  return data;
}

/**
 * Есть ли во вложенном `seo` хоть одно значение. `seo` прислан, а значений нет — это отвязка `Seo`
 * от перевода. Одно правило на проверку PATCH и на ветки записи `seo` сервисов тега и категории: разойдись
 * они — проверка сочла бы запрос отвязкой и не дошла до 409, а сервис записал бы общую строку.
 */
export function seoInputHasData(seo: object | null | undefined): boolean {
  return !!seo && Object.values(seo).some((value) => value !== null && value !== undefined);
}

/**
 * `LEGACY-436`, `T107` (решения арбитра 04.10.2026): проверка PATCH перевода тега и категории до записи.
 *
 * - `seo` из одних `null` (отвязка) и непустое плоское X — 400, даже при явном `seo.X = null`: плоское поле отвязку
 *   не перебивает, а молча оставить X в колонке, которую публика не читает, нельзя.
 * - Запрос пишет в существующую строку `Seo` (вложенный `seo` с данными или плоское зеркало),
 *   а у строки другой владелец или её нет — 409 без записи: правка ушла бы и чужой сущности
 *   (`LEGACY-400`). Строка запирается до счёта. Импорт эту проверку не зовёт: общая строка там
 *   пропускается, а не роняет всю пачку.
 */
export async function assertTranslationSeoPatchAllowed(
  tx: Prisma.TransactionClient,
  seoId: number | null,
  flat: TranslationMetaInput,
  seo?: TranslationMetaInput | null,
): Promise<void> {
  const mirrored = flatMetaForSeo(flat, seo);
  const seoHasData = seoInputHasData(seo);
  if (seo && !seoHasData) {
    // Плоское X берётся из самого запроса, а не из `mirrored`: явный `seo.X = null` при отвязке
    // ничего не выигрывает — строки `Seo` не будет (уточнение решения 1, арбитр 04.10.2026).
    const field = TRANSLATION_META_FIELDS.find((f) => {
      const value = flat[f];
      return typeof value === 'string' && value.trim() !== '';
    });
    if (field)
      throw new BadRequestException(
        `${field} cannot be set while seo is detached (all seo fields are null): send it inside seo`,
      );
    return;
  }
  if (seoId === null || (!seoHasData && Object.keys(mirrored).length === 0)) return;
  if ((await lockSeoAndCountOwners(tx, seoId)) !== 1)
    throw new ConflictException(
      'SEO record of this translation is missing or shared with another entity',
    );
}

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
 *   и бэкфилл `20261004200000_legacy_436_backfill_translation_seo`). PATCH тега и категории
 *   до этого места не доходит — `assertTranslationSeoPatchAllowed` отвечает 409.
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
  const data = flatMetaForSeo(flat, seo);
  if (Object.keys(data).length === 0) return seoId;
  if (seoId !== null) {
    // Ноль владельцев — строку только что создал тот же запрос из `seo`, перевод её ещё не держит.
    // Замок до счёта (`lockSeoAndCountOwners`): встречная привязка строки к другому владельцу
    // встаёт в очередь, а не попадает между счётом и записью. Импорт зовёт сюда без проверки PATCH —
    // для него это единственная защита общей строки.
    const owners = await lockSeoAndCountOwners(tx, seoId);
    if (owners === null || owners > 1) return seoId;
    await tx.seo.update({ where: { id: seoId }, data });
    return seoId;
  }
  if (!Object.values(data).some((value) => value !== null)) return null;
  const created = await tx.seo.create({
    data: data as Prisma.SeoCreateInput,
    select: { id: true },
  });
  return created.id;
}
