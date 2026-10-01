import { isTagTranslationIndexable } from './tag-translation-indexable.util';

/**
 * Правило «индексируема ли страница термина на языке» — одно на бэкенд (`LEGACY-422`, пачки `T73`/`T74`/
 * `T81`, решения арбитра 01.10.2026). Его читают robots и hreflang бандла (`seo.service.ts`), «похожие»
 * (`related-taxonomy.service.ts`) и свёрнутый `indexable` публичных списков тегов и категорий
 * (`TagsService.list`, `CategoryService.list`). Фронтовая пара — `isTermTranslationIndexable` в
 * `books-front/lib/seo/taxonomy-linkable.ts`: менять правило надо в обеих.
 *
 * Состав: флаги термина и перевода, `autoIndexable` перевода и `noindex` в поле Robots записи `Seo`
 * перевода. Списки и «похожие» `autoIndexable` в `indexable` **не** сворачивают — он идёт отдельным
 * полем, и фронтовый `isTaxonomyLinkable` складывает их сам; поэтому есть два уровня: «открыт»
 * (`is*TermOpen`, без автоматики) и «индексируем» (`is*TermIndexable`, с ней).
 */

/**
 * Токены строки robots (поле `Robots` записи `Seo`): нижний регистр, по запятой, без пробелов по краям.
 * Один разборщик на бэкенд — его читают и `robotsHasNoindex`, и `detectIndexability`: два разборщика
 * одной строки расходятся при первой правке одного из них (`T81`).
 */
export const robotsTokens = (robots: string | null | undefined): string[] =>
  (robots ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim());

/** Закрывает ли строка robots страницу от индекса: токен `noindex` или `none`. */
export const robotsHasNoindex = (robots: string | null | undefined): boolean =>
  robotsTokens(robots).some((part) => part === 'noindex' || part === 'none');

type SeoRobots = { robots?: string | null } | null | undefined;

/** Запись `Seo` перевода не закрывает страницу полем Robots. */
export const seoAllowsIndex = (seo: SeoRobots): boolean => !robotsHasNoindex(seo?.robots);

/** Тег ∧ перевод (`isTagTranslationIndexable`) ∧ поле Robots — без `autoIndexable`. */
export const isTagTermOpen = (
  tag: { indexable?: boolean | null } | null | undefined,
  translation: { indexable?: boolean | null } | null | undefined,
  seo: SeoRobots,
): boolean => isTagTranslationIndexable(tag, translation) && seoAllowsIndex(seo);

/** Категория, жанр, коллекция ∧ поле Robots — без `autoIndexable`; у `CategoryTranslation` своего флага нет. */
export const isCategoryTermOpen = (
  category: { indexable?: boolean | null } | null | undefined,
  seo: SeoRobots,
): boolean => category?.indexable !== false && seoAllowsIndex(seo);

/** Страница тега на языке индексируема: «открыт» ∧ `autoIndexable` перевода. */
export const isTagTermIndexable = (
  tag: { indexable?: boolean | null } | null | undefined,
  translation: { indexable?: boolean | null; autoIndexable?: boolean | null } | null | undefined,
  seo: SeoRobots,
): boolean => isTagTermOpen(tag, translation, seo) && translation?.autoIndexable !== false;

/** Страница категории, жанра или коллекции на языке индексируема: «открыт» ∧ `autoIndexable` перевода. */
export const isCategoryTermIndexable = (
  category: { indexable?: boolean | null } | null | undefined,
  translation: { autoIndexable?: boolean | null } | null | undefined,
  seo: SeoRobots,
): boolean => isCategoryTermOpen(category, seo) && translation?.autoIndexable !== false;
