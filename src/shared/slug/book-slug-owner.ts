import { Language } from '@prisma/client';

/**
 * Какая опубликованная версия забирает книжный слаг в языке адреса — одно правило выбора
 * для всех, кто разрешает слаг в памяти (`BookAnalysisService.listClaimClosures`,
 * `AuthorService.resolveBookRefs`; пачка `T145`, решение арбитра в `decisions-log.md`).
 * Повторяет первые два шага публичного `BookService.getOverview`: версия с этим слагом
 * в языке адреса, иначе первая в любом языке.
 *
 * `rows` — опубликованные версии с одним и тем же слагом, **уже упорядоченные `language asc`**:
 * помощник не сортирует, порядок задаёт запрос вызывающего (так же упорядочен запасной поиск
 * `getOverview`). Пустой список — `undefined`: третий шаг (`Book.slug`) остаётся у вызывающего,
 * потому что у каждого он свой.
 */
export function pickSlugOwner<T extends { language: Language }>(
  rows: readonly T[],
  language: Language,
): T | undefined {
  return rows.find((row) => row.language === language) ?? rows[0];
}
