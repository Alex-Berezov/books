/**
 * Правило «тег ∧ перевод»: страница тега на языке открыта, если не закрыт ни сам тег,
 * ни его перевод на этот язык (`LEGACY-422`, `T73`/`T74`). Одна копия на бэкенд вместо
 * пяти: robots (`seo.service.ts`), «похожие» (`related-taxonomy.service.ts`),
 * `TagsService.list` и обе выдачи страницы тега. Фронтовая пара —
 * `isTermTranslationIndexable` в `books-front/lib/seo/taxonomy-linkable.ts`: менять правило
 * (например, добавить `autoIndexable`) надо в обеих. Фильтр `slugsMap` в `seo.service.ts` —
 * половина правила (только перевод), под помощника не переведён.
 *
 * Сравнение с `false`, а не приведение к булеву: не заданный флаг — не закрытый, как везде
 * в этом правиле. `autoIndexable` сюда не входит — он свой у перевода и учитывается отдельно.
 */
export const isTagTranslationIndexable = (
  tag: { indexable?: boolean | null } | null | undefined,
  translation: { indexable?: boolean | null } | null | undefined,
): boolean => tag?.indexable !== false && translation?.indexable !== false;
