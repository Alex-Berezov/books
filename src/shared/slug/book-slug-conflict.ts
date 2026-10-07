import { Language, Prisma } from '@prisma/client';
import { getSupportedLanguages } from '../language/language.util';

/** Кто владеет проверяемым слагом: редактируемая версия и её книга. */
export interface VersionSlugOwner {
  versionId?: string;
  bookId?: string;
}

/**
 * Может ли языковая версия взять этот слаг — одно правило на подсказку админки
 * (`BookService.checkVersionSlugExists`) и на запись (`BookVersionService` create/update).
 *
 * Повторяет то, как публичный `getOverview` резолвит адрес: версия в языке пути, затем версия
 * с этим слагом в любом языке, затем `Book.slug` (как и `isBookSlugLive` рядом). Поэтому слаг
 * занят, если его держит
 * (а) другая версия того же языка — ключ `@@unique([language, slug])`;
 * (б) `Book.slug` другой книги;
 * (в) версия другой книги в любом языке;
 * (г) `SlugRedirect.oldSlug` книжного редиректа в любом языке, ведущего на другую книгу
 *     (`findRedirectToOtherBook`): версия отвечает на адрес во всех языках, как и (в).
 * (б) и (в) молча увели бы живой адрес другой книги на эту, (г) — её проиндексированный старый
 * адрес: фронт спрашивает редирект только после 404, а `SlugRedirectService.record` при смене
 * слага на этот снимает редирект с него без фильтра по книге. Совпадение со своей книгой
 * (её `Book.slug`, её версии в других языках, её старые адреса) ведёт в ту же книгу и конфликтом
 * не считается.
 * Статус версии не учитывается: черновик занимает адрес в момент публикации. Без своей книги
 * конфликт — любое совпадение.
 *
 * 🔴 `language: { in: ... }` — у `BookVersion` нет индекса с ведущим `slug`, только
 * `@@unique([language, slug])`; без языка запрос читает таблицу целиком (как у `isBookSlugLive`).
 *
 * (б)-(г) — это `findBookSlugConflict`: одна копия правила «держит другая книга» на обе стороны.
 *
 * @returns Книга и слаг конфликта и `language`: язык версии при (а), `null` — другая книга
 *   (б)-(г); или `null`, если слаг свободен.
 */
export async function findVersionSlugConflict(
  db: Prisma.TransactionClient,
  slug: string,
  language: Language,
  owner: VersionSlugOwner,
): Promise<{ bookId: string; slug: string; language: Language | null } | null> {
  // (а) Первой — версия того же языка: её отказ называет язык, а не чужую книгу.
  const sameLanguage = await db.bookVersion.findFirst({
    where: { slug, language, ...(owner.versionId ? { NOT: { id: owner.versionId } } : {}) },
    select: { bookId: true },
  });
  if (sameLanguage) return { bookId: sameLanguage.bookId, slug, language };

  // (б)-(г) Другая книга — то же правило, что у записи `Book.slug`: одна копия на обе стороны.
  const otherBook = await findBookSlugConflict(db, slug, owner.bookId);
  return otherBook ? { bookId: otherBook.bookId, slug, language: null } : null;
}

/**
 * Версия **другой** книги с этим слагом в любом языке; без своей книги —
 * любая версия. Статус не учитывается — по той же причине, что и выше.
 */
async function findOtherBookVersionWithSlug(
  db: Prisma.TransactionClient,
  slug: string,
  ownBookId: string | undefined,
): Promise<{ bookId: string; language: Language } | null> {
  return db.bookVersion.findFirst({
    where: {
      slug,
      language: { in: getSupportedLanguages() },
      ...(ownBookId ? { NOT: { bookId: ownBookId } } : {}),
    },
    select: { bookId: true, language: true },
  });
}

/**
 * Отказ записи книжного слага, который держит другая книга: её `Book.slug`, версия или старый адрес.
 * Один текст на писателей с ответом 400 — `BookVersionService` и `BookService.update`; создание
 * книги из клиренса отвечает своей формой отказа (код `BOOK_CREATION_SLUG_TAKEN`).
 */
export const BOOK_SLUG_TAKEN_BY_OTHER_BOOK_MESSAGE =
  'Slug is already used by another book: it would take over that book’s public address';

/**
 * Может ли книга взять этот `Book.slug` — правило с обратной стороны (`LEGACY-437`): запись
 * (`BookService.update`, создание книги из клиренса) и подсказка без языка
 * (`BookService.checkSlugExists`). `Book.slug` — фоллбэк `getOverview` во всех языках: версия
 * нашлась бы раньше него, а старый адрес он сам бы затенил (фронт спрашивает редирект только после
 * 404, а `SlugRedirectService.record` снимает редирект с занятого слага без фильтра по книге).
 * Поэтому слаг занят, если его держит
 * (а) `Book.slug` другой книги — его ловит и `@unique`, но здесь он приходит отказом, а не `P2002`;
 * (б) версия другой книги в любом языке;
 * (в) старый адрес другой книги в любом языке (`findRedirectToOtherBook`).
 * Без своей книги (создание) конфликт — любое совпадение.
 *
 * @returns Книга, которая держит слаг, или `null`, если слаг свободен.
 */
export async function findBookSlugConflict(
  db: Prisma.TransactionClient,
  slug: string,
  ownBookId: string | undefined,
): Promise<{ bookId: string } | null> {
  const book = await db.book.findFirst({
    where: { slug, ...(ownBookId ? { NOT: { id: ownBookId } } : {}) },
    select: { id: true },
  });
  if (book) return { bookId: book.id };
  const version = await findOtherBookVersionWithSlug(db, slug, ownBookId);
  if (version) return { bookId: version.bookId };
  return findRedirectToOtherBook(db, slug, ownBookId);
}

/**
 * Книжный редирект с этого слага в любом языке, ведущий на адрес, который держит другая книга —
 * её версия (любой язык, любой статус) или `Book.slug`. Порядок `getOverview` здесь не повторяется:
 * держит ли цель **хоть одна** другая книга — правило строже резолва, но не мягче (решение арбитра
 * 05.10.2026). Редирект на мёртвый адрес никого не держит; своя книга — не конфликт: вернуть себе
 * свой старый адрес можно.
 *
 * 🔴 Редирект и держатель его цели читаются **одним оператором** (решение арбитра 05.10.2026, круг 3).
 * Встречная смена слага `b→c` другой книги переписывает цепочку `a→b` в `a→c` в той же транзакции,
 * что и саму версию, а замок на `a` она не берёт. Два отдельных запроса могли увидеть `a→b` до её
 * коммита и пустой `b` после — и пропустить перехват. Один оператор в READ COMMITTED видит один
 * снимок: либо `a→b` с держателем `b`, либо `a→c` с держателем `c`. Интеграционного теста на две
 * встречные транзакции нет — гарантию даёт эта семантика.
 */
async function findRedirectToOtherBook(
  db: Prisma.TransactionClient,
  slug: string,
  ownBookId: string | undefined,
): Promise<{ bookId: string } | null> {
  const languages = getSupportedLanguages();
  const own = ownBookId ?? null;
  // `language = ANY(...)` у `BookVersion` — ради индекса `@@unique([language, slug])`, как выше.
  const rows = await db.$queryRaw<{ bookId: string }[]>`
    SELECT holder."bookId" FROM (
      SELECT bv."bookId"
        FROM "SlugRedirect" r
        JOIN "BookVersion" bv
          ON bv.slug = r."newSlug" AND bv.language = ANY(${languages}::"Language"[])
       WHERE r."entityType" = 'book'
         AND r.language = ANY(${languages}::"Language"[])
         AND r."oldSlug" = ${slug}
         AND (${own}::text IS NULL OR bv."bookId" <> ${own}::text)
      UNION ALL
      SELECT b.id AS "bookId"
        FROM "SlugRedirect" r
        JOIN "Book" b ON b.slug = r."newSlug"
       WHERE r."entityType" = 'book'
         AND r.language = ANY(${languages}::"Language"[])
         AND r."oldSlug" = ${slug}
         AND (${own}::text IS NULL OR b.id <> ${own}::text)
    ) holder
    LIMIT 1`;
  return rows[0]?.bookId ? { bookId: rows[0].bookId } : null;
}

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_SLUG_LOCK_NAMESPACE = 831_427_005;

/**
 * Замок на книжные слаги до конца транзакции — общий для всех писателей адреса книги:
 * `BookVersion.slug` (`BookVersionService`) и `Book.slug` (`BookService.update`, создание книги
 * из клиренса; `LEGACY-437`). Межкнижный конфликт индекс не держит (у версии только
 * `@@unique([language, slug])`, а `Book.slug` с версиями и редиректами не сверяется вовсе): две
 * встречные записи одного слага прошли бы проверку обе. Замок ставит их в очередь до коммита —
 * вторая увидит строку первой.
 *
 * Запирается и **прежний** слаг при смене: он в той же транзакции становится старым адресом
 * (`SlugRedirect.oldSlug`), а встречная запись, взявшая его под своим замком, не увидела бы ни
 * редиректа, ни строки. Замки берутся в порядке ключей — две встречные смены `a→b` и `b→a`
 * не ждут друг друга по кругу.
 */
export async function lockBookSlugs(
  tx: Prisma.TransactionClient,
  ...slugs: (string | null | undefined)[]
): Promise<void> {
  const distinct = [...new Set(slugs.filter((s): s is string => !!s))];
  if (distinct.length === 0) return;
  if (distinct.length === 1) {
    await tx.$queryRaw`
      SELECT true AS locked
        FROM pg_advisory_xact_lock(${BOOK_SLUG_LOCK_NAMESPACE}::int4, hashtext(${distinct[0]}::text))`;
    return;
  }
  // Ключ замка — `hashtext(slug)`, а не сам слаг: порядок берётся по ключам, иначе два слага
  // с совпавшим хешем у встречных транзакций дали бы обратный порядок и взаимную блокировку.
  // Совпавшие ключи сливаются в один замок.
  const keys = await tx.$queryRaw<{ key: number }[]>`
    SELECT DISTINCT hashtext(s) AS key FROM unnest(${distinct}::text[]) AS s ORDER BY key`;
  for (const { key } of keys) {
    await tx.$queryRaw`
      SELECT true AS locked
        FROM pg_advisory_xact_lock(${BOOK_SLUG_LOCK_NAMESPACE}::int4, ${key}::int4)`;
  }
}
