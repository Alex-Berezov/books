import { Language, LlmOperationStatus, Prisma } from '@prisma/client';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_LANGUAGE_LOCK_NAMESPACE = 831_427_007;

/**
 * Явный дедлайн транзакций под замком языка книги (`L-020`). Константа **одна** на ручное создание
 * версии и старт запуска перевода: они ждут друг друга на одном замке, и разъехавшиеся бюджеты
 * отдали бы проигравшему `P2028` и 500 вместо отказа (решение арбитра `F05 | F05-4b`). Создание
 * версии под ней же ждёт и замок слага (`assertVersionSlugFree`), который встречная правка слага
 * держит до своего коммита.
 */
export const BOOK_LANGUAGE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Операция запуска перевода держит язык, пока она `active` или `paused` по любой причине (Р23):
 * отменённый, упавший и законченный запуск язык освобождают.
 */
export const UNFINISHED_RUN_STATUSES: readonly LlmOperationStatus[] = ['active', 'paused'];

/**
 * Замок пары (книга, язык) — ручное создание версии и старт запуска перевода (Р6). Берётся
 * **первым оператором** транзакции; языки — в отсортированном порядке, иначе два встречных
 * запуска на одни и те же языки ловят взаимную блокировку.
 */
export async function lockBookLanguages(
  tx: Prisma.TransactionClient,
  bookId: string,
  languages: readonly Language[],
): Promise<void> {
  for (const language of [...new Set(languages)].sort()) {
    await tx.$queryRaw`SELECT true AS locked
      FROM pg_advisory_xact_lock(${BOOK_LANGUAGE_LOCK_NAMESPACE}::int4, hashtext(${`${bookId}:${language}`}::text))`;
  }
}

/**
 * Языки книги, на которые идёт перевод: один предикат на замок и на причину
 * `TRANSLATION_IN_PROGRESS` (Р23). Без `languages` — все языки книги. Строк не больше пяти:
 * язык держит один незавершённый запуск. `exceptRunId` - запуск, который создаёт версию сам
 * (`F05-6`, 6b): своего черновика он себе не мешает.
 */
export async function unfinishedRunLanguages(
  db: Pick<Prisma.TransactionClient, 'translationRunLanguage'>,
  bookId: string,
  languages?: readonly Language[],
  exceptRunId?: string,
): Promise<Language[]> {
  const rows = await db.translationRunLanguage.findMany({
    where: {
      ...(languages ? { language: { in: [...languages] } } : {}),
      run: {
        ...(exceptRunId ? { id: { not: exceptRunId } } : {}),
        bookVersion: { bookId },
        operation: { status: { in: [...UNFINISHED_RUN_STATUSES] } },
      },
    },
    select: { language: true },
    distinct: ['language'],
  });
  return rows.map((r) => r.language);
}
