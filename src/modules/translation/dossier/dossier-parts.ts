import { splitChapter } from '../chapter-blocks';
import { FingerprintChapter } from '../source-fingerprint';

/**
 * Длина куска главы для первого прохода досье, в символах разметки блоков. Длинная глава
 * режется по блокам кодом, чтобы длина книги не упиралась в контекст модели (`F05-2`, шаг 7).
 */
export const DOSSIER_PART_MAX_CHARS = 40_000;

export interface DossierPartPlan {
  chapterNumber: number;
  chapterTitle: string;
  partIndex: number;
  /** Блоки куска строками `[n] текст`: номер блока главы, переводимые блоки по порядку. */
  text: string;
}

/** План первого прохода, который хранит строка досье: глава и число её кусков. */
export interface DossierPlanEntry {
  chapterNumber: number;
  parts: number;
}

/**
 * Куски одной главы: блоки подряд, пока не превышен предел. Детерминирован по тексту главы:
 * тот же текст - те же куски, поэтому шаг находит уже сохранённые частичные досье.
 */
export function planChapterParts(chapter: FingerprintChapter): DossierPartPlan[] {
  const lines = splitChapter(chapter.content)
    .blocks.filter((b) => b.translatable)
    .map((b) => `[${b.n}] ${b.html}`);
  const parts: DossierPartPlan[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (current.length === 0) return;
    parts.push({
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      partIndex: parts.length,
      text: current.join('\n'),
    });
    current = [];
    length = 0;
  };
  // Блок длиннее куска (глава без разбивки на абзацы) режется по символам: досье читает текст,
  // а не блоки, и кусок не должен упираться в контекст модели.
  const sized = lines.flatMap((line) =>
    line.length <= DOSSIER_PART_MAX_CHARS
      ? [line]
      : Array.from({ length: Math.ceil(line.length / DOSSIER_PART_MAX_CHARS) }, (_, i) =>
          line.slice(i * DOSSIER_PART_MAX_CHARS, (i + 1) * DOSSIER_PART_MAX_CHARS),
        ),
  );
  for (const line of sized) {
    if (length > 0 && length + line.length > DOSSIER_PART_MAX_CHARS) flush();
    current.push(line);
    length += line.length + 1;
  }
  flush();
  return parts;
}

/** Куски первого прохода по главам исходника: глава без переводимого текста кусков не даёт. */
export function planDossierParts(chapters: readonly FingerprintChapter[]): DossierPartPlan[] {
  return [...chapters].sort((a, b) => a.number - b.number).flatMap(planChapterParts);
}

/** Сжатый план для строки досье. */
export function planEntries(plans: readonly DossierPartPlan[]): DossierPlanEntry[] {
  const entries: DossierPlanEntry[] = [];
  for (const plan of plans) {
    const last = entries[entries.length - 1];
    if (last?.chapterNumber === plan.chapterNumber) last.parts += 1;
    else entries.push({ chapterNumber: plan.chapterNumber, parts: 1 });
  }
  return entries;
}

/** План из Json строки: элемент не той формы пропускается (строку пишет только код). */
export function readPlan(value: unknown): DossierPlanEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const e = v as Partial<DossierPlanEntry> | null;
    return e && Number.isInteger(e.chapterNumber) && Number.isInteger(e.parts)
      ? [{ chapterNumber: e.chapterNumber as number, parts: e.parts as number }]
      : [];
  });
}

/** Первый несохранённый кусок плана; `null` - первый проход закончен. */
export function nextPlannedPart(
  plan: readonly DossierPlanEntry[],
  saved: ReadonlySet<string>,
): { chapterNumber: number; partIndex: number } | null {
  for (const entry of plan) {
    for (let partIndex = 0; partIndex < entry.parts; partIndex++) {
      if (!saved.has(partKey(entry.chapterNumber, partIndex))) {
        return { chapterNumber: entry.chapterNumber, partIndex };
      }
    }
  }
  return null;
}

export function partKey(chapterNumber: number, partIndex: number): string {
  return `${chapterNumber}:${partIndex}`;
}
