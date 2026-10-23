import { TranslationChunkStatus } from '@prisma/client';
import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { assembleChapter, ChapterLayout } from '../chapter-blocks';
import { normalized } from '../check/mechanical-check';
import { TranslatedBlock } from '../translate/translate.format';
import { chunkBlocks } from '../translate/translate-piece';

/**
 * Коды флага и находок главы перевода (`F05-6`, шаги 2-3) - одна таблица (`flagReason`,
 * `findings`, отчёт и экран `F05-7`). Первые три главу в черновик не пускают (Р8; решение
 * арбитра `F05 | F05-6`: исходник вместо перевода не подставляется), остальные - флаг на
 * записанной главе.
 */
export const ASSEMBLY_FLAG_REASONS = {
  /** Собранная глава после санитайзера длиннее `RICH_HTML_MAX_LENGTH.body` (Р8). */
  CHAPTER_TOO_LONG: 'CHAPTER_TOO_LONG',
  /** У куска нет перевода части блоков: флаг без ответа модели (`CHUNK_TOO_LONG` и подобные). */
  CHUNK_UNTRANSLATED: 'CHUNK_UNTRANSLATED',
  /** Куски не покрывают блоки главы по порядку и без дыр. */
  CHUNKS_MISMATCH: 'CHUNKS_MISMATCH',
  /** Кусок с флагом проверок, но с переводом: идёт в главу, флаг - редактору. */
  CHUNK_FLAGGED: 'CHUNK_FLAGGED',
  /** На стыке кусков перевод повторяет блок (`product.md` §4, «Глава»). */
  SEAM_REPEAT: 'SEAM_REPEAT',
} as const;

export type AssemblyFlagReason = (typeof ASSEMBLY_FLAG_REASONS)[keyof typeof ASSEMBLY_FLAG_REASONS];

export interface AssemblyFinding {
  code: AssemblyFlagReason;
  /** Номер стыка с 1: между кусками `seam - 1` и `seam`. */
  seam?: number;
  chunkIndex?: number;
  /** Причина флага куска (`CHUNK_FLAGGED`). */
  chunkReason?: string;
}

export interface AssemblyChunk {
  chunkIndex: number;
  firstBlock: number;
  lastBlock: number;
  status: TranslationChunkStatus;
  blocks: unknown;
  flagReason: string | null;
}

/**
 * Итог сборки главы. `assembled` - глава пойдёт в черновик, `flagReason` - первая находка, если
 * она есть; `flagged` - не пойдёт. `content` - собранный текст после санитайзера: в 6a он только
 * меряется, записывает его `F05-6` (6b) той же функцией.
 */
export type ChapterAssembly =
  | {
      status: 'assembled';
      content: string;
      length: number;
      flagReason: AssemblyFlagReason | null;
      seamIndex: number | null;
      findings: AssemblyFinding[];
    }
  | {
      status: 'flagged';
      length: number | null;
      flagReason: AssemblyFlagReason;
      findings: AssemblyFinding[];
    };

/** Короче - повтор на стыке не ищется: короткая реплика повторяется законно. */
const SEAM_REPEAT_MIN_CHARS = 20;

const NOT_WRITTEN: ReadonlySet<AssemblyFlagReason> = new Set([
  ASSEMBLY_FLAG_REASONS.CHAPTER_TOO_LONG,
  ASSEMBLY_FLAG_REASONS.CHUNK_UNTRANSLATED,
  ASSEMBLY_FLAG_REASONS.CHUNKS_MISMATCH,
]);

/** Текст блока для сравнения: без разметки, регистра и диакритики, пробелы схлопнуты. */
function plain(html: string): string {
  return normalized(richHtmlText(html)).replace(/\s+/g, ' ').trim();
}

/** Куски покрывают блоки главы `1..N` по порядку и без дыр; глава без блоков - один пустой кусок. */
function chunksCover(chunks: readonly AssemblyChunk[], blocks: number): boolean {
  if (chunks.some((c, i) => c.chunkIndex !== i)) return false;
  if (blocks === 0) return chunks.length === 1;
  if (chunks.length === 0 || chunks[0].firstBlock !== 1) return false;
  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i].firstBlock !== chunks[i - 1].lastBlock + 1) return false;
  }
  return chunks[chunks.length - 1].lastBlock === blocks;
}

/**
 * Перевод блоков куска по номерам: каждый переводимый блок - непустой текст. Нет хоть одного -
 * `null`: собрать главу из такого куска можно только подставив исходник.
 */
function chunkTranslation(
  layout: Pick<ChapterLayout, 'blocks'>,
  chunk: AssemblyChunk,
): Map<number, string> | null {
  const translated = Array.isArray(chunk.blocks) ? (chunk.blocks as TranslatedBlock[]) : [];
  const byNumber = new Map(
    translated
      .filter((b) => typeof b?.n === 'number' && typeof b.text === 'string' && b.text.trim() !== '')
      .map((b) => [b.n, b.text]),
  );
  const expected = chunkBlocks(layout, chunk).map((b) => b.n);
  return expected.every((n) => byNumber.has(n))
    ? new Map(expected.map((n) => [n, byNumber.get(n) as string]))
    : null;
}

/**
 * Повтор на стыке: первый блок куска совпадает с последним блоком прошлого или начинается с него
 * (модель повторила хвост, который видела в промпте). Совпадение в самом исходнике - не повтор.
 */
function seamRepeated(
  layout: Pick<ChapterLayout, 'blocks'>,
  previous: AssemblyChunk,
  next: AssemblyChunk,
  replacements: ReadonlyMap<number, string>,
): boolean {
  const last = chunkBlocks(layout, previous).at(-1);
  const first = chunkBlocks(layout, next)[0];
  if (!last || !first) return false;
  const [sourceLast, sourceFirst] = [plain(last.html), plain(first.html)];
  const lastText = plain(replacements.get(last.n) ?? '');
  const firstText = plain(replacements.get(first.n) ?? '');
  // Короткие реплики («Sí.») законно совпадают у разных строк исходника - повтором не считаются.
  if (lastText.length < SEAM_REPEAT_MIN_CHARS) return false;
  if (lastText === firstText) return sourceLast !== sourceFirst;
  return firstText.startsWith(lastText) && !sourceFirst.startsWith(sourceLast);
}

/**
 * Сборка главы перевода из кусков (`F05-6`, шаги 2-3, проверка стыков кодом): куски по порядку
 * и без дыр, у каждого перевод всех переводимых блоков, на стыке нет повтора; блоки на места
 * (`assembleChapter`), тот же санитайзер, что у ручной записи, и предел длины - константа, а не
 * копия числа (Р8). Модель стыки здесь не читает: это `check_semantic` в 6c.
 */
export function assembleTranslatedChapter(
  layout: Pick<ChapterLayout, 'blocks' | 'parts'>,
  chunks: readonly AssemblyChunk[],
): ChapterAssembly {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (!chunksCover(ordered, layout.blocks.length)) {
    return flagged(null, [{ code: ASSEMBLY_FLAG_REASONS.CHUNKS_MISMATCH }]);
  }
  const findings: AssemblyFinding[] = [];
  const replacements = new Map<number, string>();
  for (const chunk of ordered) {
    const translation = chunkTranslation(layout, chunk);
    if (!translation) {
      findings.push({
        code: ASSEMBLY_FLAG_REASONS.CHUNK_UNTRANSLATED,
        chunkIndex: chunk.chunkIndex,
      });
      continue;
    }
    for (const [n, text] of translation) replacements.set(n, text);
    if (chunk.status === 'flagged') {
      findings.push({
        code: ASSEMBLY_FLAG_REASONS.CHUNK_FLAGGED,
        chunkIndex: chunk.chunkIndex,
        chunkReason: chunk.flagReason ?? undefined,
      });
    }
  }
  if (findings.some((f) => NOT_WRITTEN.has(f.code))) {
    return flagged(null, findings);
  }
  for (let i = 1; i < ordered.length; i++) {
    if (seamRepeated(layout, ordered[i - 1], ordered[i], replacements)) {
      findings.push({ code: ASSEMBLY_FLAG_REASONS.SEAM_REPEAT, seam: i });
    }
  }
  const content = sanitizeRichHtml(assembleChapter(layout, replacements));
  if (content.length > RICH_HTML_MAX_LENGTH.body) {
    return flagged(content.length, [{ code: ASSEMBLY_FLAG_REASONS.CHAPTER_TOO_LONG }, ...findings]);
  }
  return {
    status: 'assembled',
    content,
    length: content.length,
    flagReason: findings[0]?.code ?? null,
    seamIndex: findings.find((f) => f.seam !== undefined)?.seam ?? null,
    findings,
  };
}

function flagged(length: number | null, findings: AssemblyFinding[]): ChapterAssembly {
  const first = findings.find((f) => NOT_WRITTEN.has(f.code)) ?? findings[0];
  return { status: 'flagged', length, flagReason: first.code, findings };
}
