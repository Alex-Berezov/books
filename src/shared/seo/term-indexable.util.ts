import { isTagTranslationIndexable } from './tag-translation-indexable.util';

/**
 * Правило «индексируема ли страница термина на языке» — одно на бэкенд (`LEGACY-422`, пачки `T73`/`T74`/
 * `T81`/`T90`, решения арбитра 01.10.2026 и 03.10.2026). Его читают robots и hreflang бандла
 * (`seo.service.ts`), «похожие» (`related-taxonomy.service.ts`) и свёрнутый `indexable` публичных выдач:
 * списки тегов и категорий (`TagsService.list`, `CategoryService.list`), карточки и выдача страницы тега
 * (`BookService.findCardsByTag`, `TagsService.versionsByTagLangSlug`), карточки и детали категории
 * (`BookService.findCardsByCategory`, `CategoryService.getByLangSlugWithBooks`), `translations[]` дерева
 * категорий с языком (`CategoryService.getTree`) и ответа книги (`BookService.getOverview`, чипы).
 * Фронтовая пара — `isTermTranslationIndexable` в `books-front/lib/seo/taxonomy-linkable.ts`: менять
 * правило надо в обеих.
 *
 * Состав: флаги термина и перевода, `autoIndexable` перевода и `noindex` в поле Robots записи `Seo`
 * перевода. Списки и «похожие» `autoIndexable` в `indexable` **не** сворачивают — он идёт отдельным
 * полем, и фронтовый `isTaxonomyLinkable` складывает их сам; поэтому есть два уровня: «открыт»
 * (`is*TermOpen`, без автоматики) и «индексируем» (`is*TermIndexable`, с ней).
 */

/** Директивы, которые читаются и за датой `unavailable_after` без запятой. */
const DATE_TAIL_DIRECTIVES = new Set(['noindex', 'none', 'nofollow']);

/**
 * Директивы robots со значением через двоеточие (`max-image-preview:none`): имя директивы — это
 * не префикс бота, её значение токеном не становится — иначе `max-image-preview:none` дал бы `none`
 * и закрыл бы страницу (ревью `T90`).
 */
const VALUE_DIRECTIVES = new Set([
  'max-snippet',
  'max-image-preview',
  'max-video-preview',
  'unavailable_after',
]);

/**
 * Токены строки robots (поле `Robots` записи `Seo`): нижний регистр, по запятой и пробелам, без
 * префикса бота — `googlebot: noindex` и `googlebot:noindex` дают `noindex` (`T90`, решение арбитра
 * 03.10.2026: явный `noindex` редактора для любого бота закрывает страницу). Директива со значением
 * (`VALUE_DIRECTIVES`) даёт токен своего имени, значение отбрасывается.
 * Один разборщик на бэкенд — его читают и `robotsHasNoindex`, и `detectIndexability`: два разборщика
 * одной строки расходятся при первой правке одного из них (`T81`).
 */
export const robotsTokens = (robots: string | null | undefined): string[] => {
  const tokens: string[] = [];
  for (const part of (robots ?? '').toLowerCase().split(',')) {
    let rest = part.trim();
    while (rest !== '') {
      const named = /^([a-z0-9_-]+)\s*:\s*/.exec(rest);
      if (named && VALUE_DIRECTIVES.has(named[1])) {
        tokens.push(named[1]);
        // Значение `unavailable_after` (дата с пробелами) — до конца части, у остальных — одно слово.
        // В дате не бывает слов `noindex`/`none`/`nofollow`: директива за датой без запятой всё равно
        // читается (решение арбитра 03.10.2026, ревью `T90`), сравнение — по целому слову.
        if (named[1] === 'unavailable_after') {
          const value = rest.slice(named[0].length).split(/\s+/);
          tokens.push(...value.filter((word) => DATE_TAIL_DIRECTIVES.has(word)));
          break;
        }
        rest = rest.slice(named[0].length).replace(/^\S*\s*/, '');
        continue;
      }
      if (named) {
        // Префикс бота: `googlebot: noindex` — директивы после него разбираются как обычные.
        rest = rest.slice(named[0].length);
        continue;
      }
      const word = /^\S+/.exec(rest)?.[0] ?? rest;
      tokens.push(word);
      rest = rest.slice(word.length).trimStart();
    }
  }
  return tokens;
};

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

/**
 * Перевод категории, жанра или коллекции для публичной выдачи: `indexable` — нет `noindex`/`none`
 * в поле Robots его `Seo` (своего флага у перевода категории нет), сам `seo` снят. Одна свёртка на
 * ответ книги (`categories`, `primaryCategory`) и дерево категорий с языком (`T90`).
 */
export const foldCategoryTranslation = <T extends { seo?: SeoRobots }>(
  tr: T,
): Omit<T, 'seo'> & { indexable: boolean } => ({
  ...withoutSeo(tr),
  indexable: isCategoryTermOpen(null, tr.seo),
});

/**
 * Перевод тега для публичной выдачи: `indexable` — флаг перевода ∧ нет `noindex`/`none` в поле Robots
 * его `Seo`, сам `seo` снят (`T90`, ответ книги).
 */
export const foldTagTranslation = <T extends { seo?: SeoRobots; indexable?: boolean | null }>(
  tr: T,
): Omit<T, 'seo'> & { indexable: boolean } => ({
  ...withoutSeo(tr),
  indexable: isTagTermOpen(null, tr, tr.seo),
});

/**
 * Перевод без вложенного `seo`: поле Robots читается для свёртки `indexable` и наружу не уходит
 * (`T90` — ответ книги, дерево категорий, карточки тега).
 */
export const withoutSeo = <T extends { seo?: unknown }>(row: T): Omit<T, 'seo'> => {
  const { seo, ...rest } = row;
  void seo; // нужен только для свёртки флага, в ответ не идёт
  return rest;
};
