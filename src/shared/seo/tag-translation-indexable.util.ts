/**
 * Правило «тег ∧ перевод»: страница тега на языке открыта, если не закрыт ни сам тег,
 * ни его перевод на этот язык (`LEGACY-422`, `T73`/`T74`). Это половина общего правила
 * индексируемости термина: вторая половина (поле Robots `Seo` перевода, `autoIndexable`, категории)
 * живёт рядом, в `term-indexable.util.ts` (`T81`), и читает этот помощник. Фронтовая пара —
 * `isTermTranslationIndexable` в `books-front/lib/seo/taxonomy-linkable.ts`: менять правило
 * надо в обеих.
 *
 * Сравнение с `false`, а не приведение к булеву: не заданный флаг — не закрытый, как везде
 * в этом правиле. `autoIndexable` сюда не входит — он свой у перевода и учитывается отдельно.
 */
export const isTagTranslationIndexable = (
  tag: { indexable?: boolean | null } | null | undefined,
  translation: { indexable?: boolean | null } | null | undefined,
): boolean => tag?.indexable !== false && translation?.indexable !== false;
