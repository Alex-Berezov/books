import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { SEAM_FINDING_CODES } from '../check/seam-check';
import { ChapterFlagCode, DRAFT_FLAG_REASONS } from '../draft/draft.constants';
import { FINAL_FINDING_CODES } from '../final-check/final-check.constants';
import { ASSEMBLY_FLAG_REASONS, AssemblyFinding } from './chapter-assembly';

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
    /**
     * Флаг заменяет прежний (глава не пишется в черновик: `flagReason` - то, почему её там нет,
     * прежний флаг остаётся в находках); счётчик - всё так же один раз на главу.
     */
    overwriteFlag?: boolean;
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
  } else if (options.overwriteFlag) {
    await tx.translationChapter.updateMany({
      where: { id: row.id },
      data: { flagReason: flag.code },
    });
  }
  return true;
}

/** Находка главы, как она лежит в `TranslationChapter.findings`; `stale` - к тексту до правки. */
export interface StoredFinding {
  code: string;
  seam?: number;
  stale?: boolean;
  [key: string]: unknown;
}

const ASSEMBLY_CODES: ReadonlySet<string> = new Set(Object.values(ASSEMBLY_FLAG_REASONS));
const DRAFT_CODES: ReadonlySet<string> = new Set(Object.values(DRAFT_FLAG_REASONS));

/**
 * Находки главы после повтора или правки куска (решение арбитра `F05 | F05-7v`): находки сборки -
 * кода, бесплатные - заменяются свежими; находки записи черновика остаются; ответы моделей
 * (стыки, итоговая проверка) и их записи `*_CHECKED` остаются с `stale: true` - оплаченное
 * не стирается, но к новому тексту не относится. `notWritten` - глава не пишется: её код
 * последней находкой, как у записи черновика.
 */
export function rebuiltFindings(
  previous: Prisma.JsonValue,
  fresh: readonly AssemblyFinding[],
  notWritten: ChapterFlagCode | null = null,
): StoredFinding[] {
  const kept = (Array.isArray(previous) ? previous : [])
    .filter(isRecord)
    .map((f) => f as unknown as StoredFinding)
    .filter((f) => typeof f.code === 'string' && !ASSEMBLY_CODES.has(f.code))
    .filter((f) => f.code !== DRAFT_FLAG_REASONS.SOURCE_CHANGED)
    .map((f) => (DRAFT_CODES.has(f.code) ? f : { ...f, stale: true }));
  const added: StoredFinding[] = fresh.map((f) => ({ ...f }));
  const tail: StoredFinding[] =
    notWritten && !fresh.some((f) => f.code === notWritten) ? [{ code: notWritten }] : [];
  return [...added, ...kept, ...tail];
}

/** Флаг и номер стыка главы по действующим находкам: без `stale` и без записей ответов. */
export function activeFlagOf(
  findings: readonly StoredFinding[],
  notWritten: string | null = null,
): { flagReason: string | null; seamIndex: number | null } {
  const active = findings.filter((f) => !f.stale && isFlagFinding(f));
  return {
    flagReason: notWritten ?? active[0]?.code ?? null,
    seamIndex: active.find((f) => typeof f.seam === 'number')?.seam ?? null,
  };
}

/**
 * Запись пересобранных находок главы, строка которой уже под замком транзакции (`FOR UPDATE`):
 * `flagReason` и `seamIndex` - по действующим, `flaggedChapters` языка - ±1 по переходу флага
 * «был → нет» и «не было → есть», условием на счётчик, чтобы не уйти ниже нуля. `data` - переход
 * статуса и прочие поля той же записью.
 */
export async function writeRebuiltFindings(
  tx: Prisma.TransactionClient,
  languageId: string,
  locked: { id: string; flagReason: string | null },
  findings: readonly StoredFinding[],
  data: Prisma.TranslationChapterUncheckedUpdateInput,
  /** Глава не в черновике: флаг - то, почему её там нет (код сборки или отказ перезаписи). */
  notWritten: string | null = null,
): Promise<void> {
  const { flagReason, seamIndex } = activeFlagOf(findings, notWritten);
  await tx.translationChapter.update({
    where: { id: locked.id },
    data: {
      ...data,
      flagReason,
      seamIndex,
      findings: findings as unknown as Prisma.InputJsonValue,
    },
  });
  const was = locked.flagReason !== null;
  const now = flagReason !== null;
  if (was === now) return;
  await tx.translationRunLanguage.updateMany({
    where: { id: languageId, ...(now ? {} : { flaggedChapters: { gt: 0 } }) },
    data: { flaggedChapters: now ? { increment: 1 } : { decrement: 1 } },
  });
}
