import { ContributorRole, Language, Prisma } from '@prisma/client';

/** Сколько переводчиков версии отдаётся на страницу книги. */
export const TRANSLATORS_LIMIT = 10;

/**
 * Выборка переводчиков версии для блока «Об издании» (F01-5): только роль `TRANSLATOR` и только
 * имена - `id`, `role`, `creditedName`, `contributionNoteRu` и поля прав в неё не входят. Перевод
 * имени - только на языке запроса.
 *
 * ⚠️ Намеренно не в белом списке `PUBLIC_BOOK_VERSION_OVERVIEW_SELECT`: связь нельзя отдавать как
 * есть, её сворачивает `mapTranslators`. Лежи она в общем списке, второй потребитель по образцу
 * `versions.map((v) => ({ ...v }))` отдал бы сырой список молча. Добавляется к выборке явно,
 * как `_count`, вложенным `select` в том же запросе - без N+1.
 */
export const translatorsSelect = (language: Language) =>
  ({
    where: { role: ContributorRole.TRANSLATOR },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: TRANSLATORS_LIMIT,
    select: {
      person: {
        select: {
          canonicalName: true,
          translations: { where: { language }, select: { displayName: true } },
        },
      },
    },
  }) satisfies Prisma.BookVersion$contributorsArgs;

/** Контрибьютор-переводчик в том виде, в каком его отдаёт `translatorsSelect`. */
export interface TranslatorRow {
  person: {
    canonicalName: string;
    translations: { displayName: string }[];
  };
}

export interface PublicTranslator {
  name: string;
}

/**
 * Имена переводчиков версии. Имя - `PersonTranslation.displayName` на языке запроса, без такого
 * перевода - `Person.canonicalName`. Порядок и лимит заданы выборкой. Пустые имена и повторы одного
 * имени отбрасываются: связь не уникальна по персоне и роли, и одна персона дважды дала бы
 * «Перевод: X, X». Пустой список - `[]`, не `null`.
 */
export const mapTranslators = (rows: readonly TranslatorRow[]): PublicTranslator[] => {
  const names = rows.map(
    (row) => row.person.translations[0]?.displayName.trim() || row.person.canonicalName.trim(),
  );
  return Array.from(new Set(names.filter((name) => name.length > 0))).map((name) => ({ name }));
};
