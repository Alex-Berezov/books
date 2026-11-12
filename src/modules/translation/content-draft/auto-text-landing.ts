import { Prisma } from '@prisma/client';
import { AUTO_TEXT_MARKS_SELECT, AutoTextKind } from '../../book-version/auto-text-marks';
import { stableJson } from '../draft-quality/draft-record';
import { lockVersionRow } from '../version-lock';

/**
 * `T184`: отметка редактора «прочитано» перед публикацией автотекста (слово владельца 09.11.2026;
 * решение арбитра 12.11.2026 `T184 | LEGACY-493 | LEGACY-495`, `decisions-log.md`).
 *
 * Автотекст - факт, а не ход: текст модели лёг в поля версии. Время последнего такого вклада
 * лежит на версии (`summaryAutoTextAt`, `analysisAutoTextAt`) и ставится в той же транзакции,
 * что и запись хода; отметка «прочитано» действует, только если она не раньше этого времени.
 * Так новый ход, «Accept», «Accept all», принятая перегенерация и дописанные ждущие элементы
 * после отметки снимают её сами, а «Discard run» после «Accept all» - нет: текст остался в полях.
 * Ручная правка редактором времени не двигает. Чтение отметок - `book-version/auto-text-marks.ts`,
 * сама отметка - `auto-text-read.service.ts`.
 */

/** Исходы элемента хода, при которых его текст лежит в поле версии. */
const LANDED_OUTCOMES: ReadonlySet<string> = new Set(['written', 'accepted']);

/** Общая часть данных хода пересказа и анализа, по которой видно, что текст лёг в поля. */
export interface LandingData {
  readonly items: readonly { readonly outcome: string }[];
  readonly written: unknown;
}

/**
 * Лёг ли текст модели этой записью данных хода: элемент стал записанным или принятым, или
 * изменился отпечаток записанного (перегенерация записанного элемента пишет поле заново, исход
 * остаётся `written`; блоки связей анализа пишутся вместе с темой).
 */
export function autoTextLanded(prev: LandingData, next: LandingData): boolean {
  if (stableJson(prev.written) !== stableJson(next.written)) return true;
  return next.items.some(
    (item, index) =>
      LANDED_OUTCOMES.has(item.outcome) && prev.items[index]?.outcome !== item.outcome,
  );
}

/**
 * Запомнить вклад модели в поля версии - тем же `tx`, что и запись данных хода. Время берётся
 * после замка строки версии: отметка «прочитано» ставится под тем же замком (`AutoTextReadService.mark`),
 * и время, взятое до ожидания замка, оказалось бы раньше отметки, закоммиченной, пока запись ждала, -
 * непрочитанный текст сошёл бы за прочитанный.
 */
export async function noteAutoText(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  kind: AutoTextKind,
): Promise<void> {
  await lockVersionRow(tx, bookVersionId);
  // Строго позже отметки и прежнего вклада: отметка той же миллисекунды (запись ждала её замок)
  // иначе сошла бы за прочитанное (`readAt >= autoTextAt`), а два вклада с одним временем «Mark as
  // read» с показанным временем не различил бы (`AUTO_TEXT_CHANGED`). Часы процессов порядок не решают.
  const marks = await tx.bookVersion.findUnique({
    where: { id: bookVersionId },
    select: AUTO_TEXT_MARKS_SELECT,
  });
  const [readAt, prevAt] =
    kind === 'summary'
      ? [marks?.summaryReadAt, marks?.summaryAutoTextAt]
      : [marks?.analysisReadAt, marks?.analysisAutoTextAt];
  const after = (value: Date | null | undefined) => (value ? value.getTime() + 1 : 0);
  const at = new Date(Math.max(Date.now(), after(readAt), after(prevAt)));
  await tx.bookVersion.update({
    where: { id: bookVersionId },
    data: kind === 'summary' ? { summaryAutoTextAt: at } : { analysisAutoTextAt: at },
  });
}

/**
 * Запись данных хода с учётом вклада модели (`T184`): прежние данные читаются тем же `tx` под замком
 * вызывающего, затем `write` пишет новые; лёг текст - время вклада на версии. Одна связка на ход
 * пересказа и ход анализа.
 */
export async function saveNotingAutoText<D extends LandingData>(
  tx: Prisma.TransactionClient,
  id: string,
  kind: AutoTextKind,
  next: D,
  read: (data: unknown) => D,
  write: () => Promise<void>,
): Promise<void> {
  const prev = await tx.contentDraft.findUnique({
    where: { id },
    select: { bookVersionId: true, data: true },
  });
  await write();
  if (prev && autoTextLanded(read(prev.data), next)) {
    await noteAutoText(tx, prev.bookVersionId, kind);
  }
}
