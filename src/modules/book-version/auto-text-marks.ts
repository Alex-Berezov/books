import { Prisma } from '@prisma/client';

/**
 * `T184`: прочитан ли автотекст версии (решение арбитра 12.11.2026 `T184 | LEGACY-493 |
 * LEGACY-495`, `decisions-log.md`). Время вклада модели ставит запись хода
 * (`translation/content-draft/auto-text-landing.ts`), отметку - редактор; здесь только сравнение,
 * одно на гейт, запись публикации и ручки отметки.
 */

export const AUTO_TEXT_KINDS = ['summary', 'analysis'] as const;
export type AutoTextKind = (typeof AUTO_TEXT_KINDS)[number];

/** Колонки версии, по которым гейт решает, прочитан ли автотекст. */
export interface AutoTextMarks {
  summaryAutoTextAt: Date | null;
  summaryReadAt: Date | null;
  analysisAutoTextAt: Date | null;
  analysisReadAt: Date | null;
}

export const AUTO_TEXT_MARKS_SELECT = {
  summaryAutoTextAt: true,
  summaryReadAt: true,
  analysisAutoTextAt: true,
  analysisReadAt: true,
} as const satisfies Prisma.BookVersionSelect;

/** Прочитан ли автотекст вида: его нет - читать нечего; отметка раньше вклада - не прочитан. */
export function autoTextRead(autoTextAt: Date | null, readAt: Date | null): boolean {
  if (!autoTextAt) return true;
  return readAt !== null && readAt.getTime() >= autoTextAt.getTime();
}

/** Виды автотекста версии без действующей отметки - в порядке `AUTO_TEXT_KINDS`. */
export function unreadAutoTextKinds(marks: AutoTextMarks): AutoTextKind[] {
  return AUTO_TEXT_KINDS.filter((kind) =>
    kind === 'summary'
      ? !autoTextRead(marks.summaryAutoTextAt, marks.summaryReadAt)
      : !autoTextRead(marks.analysisAutoTextAt, marks.analysisReadAt),
  );
}
