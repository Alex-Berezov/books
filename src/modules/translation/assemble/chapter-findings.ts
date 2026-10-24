import { Prisma } from '@prisma/client';
import { SEAM_FINDING_CODES } from '../check/seam-check';
import { ChapterFlagCode } from '../draft/draft.constants';
import { FINAL_FINDING_CODES } from '../final-check/final-check.constants';

/** Глава языка в объёме, нужном находкам: флаг, номер стыка и прежние находки. */
export interface ChapterFindingsRow {
  id: string;
  chapterNumber: number;
  flagReason: string | null;
  seamIndex: number | null;
  findings: Prisma.JsonValue;
}

export const CHAPTER_FINDINGS_SELECT = {
  id: true,
  chapterNumber: true,
  flagReason: true,
  seamIndex: true,
  findings: true,
} as const;

/** Находки - записи оплаченных ответов, а не флаги (`SEAM_CHECKED`, `FINAL_CHECKED`). */
const RECORD_CODES: ReadonlySet<string> = new Set([
  SEAM_FINDING_CODES.SEAM_CHECKED,
  FINAL_FINDING_CODES.FINAL_CHECKED,
]);

const isFlagFinding = (f: { code: string }): boolean => !RECORD_CODES.has(f.code);

/**
 * Находки главе в транзакции - одно правило на стыки, итоговую проверку и запись черновика
 * (`F05-6`): `added` дописываются к прежним; первая находка-флаг (среди `flagFrom`, по умолчанию -
 * `added`) ставит `flagReason`, если флага ещё не было, и считается в `flaggedChapters` один раз
 * на главу; первая находка стыка ставит `seamIndex`, если номера ещё нет. `data` и `where` -
 * переход статуса той же записью. Возвращает, записана ли глава.
 */
export async function addChapterFindings(
  tx: Prisma.TransactionClient,
  languageId: string,
  row: ChapterFindingsRow,
  added: ReadonlyArray<{ code: ChapterFlagCode; seam?: number }>,
  options: {
    data?: Prisma.TranslationChapterUncheckedUpdateManyInput;
    where?: Prisma.TranslationChapterWhereInput;
    flagFrom?: ReadonlyArray<{ code: ChapterFlagCode; seam?: number }>;
  } = {},
): Promise<boolean> {
  const previous = Array.isArray(row.findings) ? row.findings : [];
  const candidates = (options.flagFrom ?? added).filter(isFlagFinding);
  const changed = await tx.translationChapter.updateMany({
    where: { id: row.id, ...options.where },
    data: {
      ...options.data,
      ...(added.length > 0
        ? { findings: [...previous, ...added] as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });
  if (changed.count === 0) return false;
  // Флаг и номер стыка - своим условием в базе, а не по строке, прочитанной до шага: два шага
  // по одной главе (аренду забрали посреди вызова модели) не посчитают её дважды.
  const seam = candidates.find((f) => f.seam !== undefined);
  if (seam) {
    await tx.translationChapter.updateMany({
      where: { id: row.id, seamIndex: null },
      data: { seamIndex: seam.seam },
    });
  }
  const flag = candidates[0];
  if (!flag) return true;
  const flagged = await tx.translationChapter.updateMany({
    where: { id: row.id, flagReason: null },
    data: { flagReason: flag.code },
  });
  if (flagged.count > 0) {
    await tx.translationRunLanguage.update({
      where: { id: languageId },
      data: { flaggedChapters: { increment: 1 } },
    });
  }
  return true;
}
