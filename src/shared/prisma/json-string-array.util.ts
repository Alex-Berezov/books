import { Prisma } from '@prisma/client';

/**
 * Разбор `Json?`-колонки, задуманной как `string[]` (комментарий рядом с полем
 * в `schema.prisma`), на чтении. Без него ответ типизируется `unknown`, и
 * `check:response-schema` держит маршрут в ратчете «непроверяемых» (`LEGACY-417`):
 * начни сервис класть туда объект вместо массива строк — сторож это не заметит.
 *
 * `null`/`undefined` — поле не заполнено, отдаём `null`: колонка не заполнялась
 * вовсе, и это отличается от «заполнена, но пуста». Не массив — тоже `null`,
 * тем же поводом. Элементы внутри массива фильтруются, а не роняют результат
 * целиком: тот же приём, каким эта же колонка уже читается и в другом
 * месте (`rights-license-interface.ts` `toStringArray`) — одна испорченная запись не должна
 * прятать остальные валидные слаги списка.
 */
export const parseJsonStringArray = (
  value: Prisma.JsonValue | null | undefined,
): string[] | null => {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
};

/** Четыре `Json?`-колонки `TagTranslation`, задуманные как `string[]` (`schema.prisma`). */
export const RELATED_SLUG_KEYS = [
  'relatedTagSlugs',
  'relatedGenreSlugs',
  'relatedCategorySlugs',
  'relatedCollectionSlugs',
] as const;

export type RelatedSlugKey = (typeof RELATED_SLUG_KEYS)[number];

/** Строка с четырьмя `related*Slugs`, сужёнными с `Json` до `string[] | null`. */
export type WithParsedRelatedSlugs<T> = Omit<T, RelatedSlugKey> &
  Record<RelatedSlugKey, string[] | null>;

/**
 * Разбор всех четырёх `related*Slugs` строки перевода тега одним вызовом. Публичные ответы
 * (`overview`, `cards`, `/:lang/tags/:slug/books`) отдавали их сырым `Json`, и схема ответа
 * их не сверяла (`LEGACY-417`, `T74`); поведение не меняется: массив строк остаётся массивом,
 * не-массив и `null` дают `null`.
 */
export const parseRelatedSlugs = <T extends Record<RelatedSlugKey, Prisma.JsonValue | null>>(
  row: T,
): WithParsedRelatedSlugs<T> => ({
  ...row,
  relatedTagSlugs: parseJsonStringArray(row.relatedTagSlugs),
  relatedGenreSlugs: parseJsonStringArray(row.relatedGenreSlugs),
  relatedCategorySlugs: parseJsonStringArray(row.relatedCategorySlugs),
  relatedCollectionSlugs: parseJsonStringArray(row.relatedCollectionSlugs),
});
