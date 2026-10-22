import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { ChapterLayout } from '../chapter-blocks';

/**
 * Нарезка главы на куски перевода (`F05-3`, шаг 1; `tech.md` §2, этап 3). Кусок - подряд идущие
 * блоки главы, 1500-3000 слов. Граница - между блоками: предпочтение - разделитель сцены (`hr`,
 * пустой абзац, `***`); граница перед репликой не ставится (блок с тире или кавычкой в начале
 * не отрывается от предыдущего). Разделителя в окне нет - стык спорный, его выбирает вызывающий:
 * этап `split` моделью, запасной - код (`fallbackBoundary`, Р7).
 */

export const CHUNK_MIN_WORDS = 1_500;
export const CHUNK_MAX_WORDS = 3_000;
/** Сколько слов начала блока уходит модели этапа `split` на кандидата границы. */
const HEAD_WORDS = 12;

/** Кусок: блоки `firstBlock..lastBlock` включительно, номера - как в `splitChapter`. */
export interface ChapterChunk {
  firstBlock: number;
  lastBlock: number;
  words: number;
}

/** Кандидат границы: кусок кончается перед блоком `block`. */
export interface BoundaryCandidate {
  block: number;
  /** Слов в куске, если граница здесь. */
  words: number;
  /** Перед репликой: допустим, только если других нет. */
  beforeDialogue: boolean;
  /** Первые слова блока после границы - то, что видит модель. */
  head: string;
}

/** Спорный стык: окно кандидатов, ни один не разделитель сцены. */
export interface ContestedWindow {
  candidates: BoundaryCandidate[];
}

type Info = { n: number; words: number; text: string; scene: boolean; dialogue: boolean };

const SCENE_MARK = /^(?:[*•·~#]\s*){1,5}$|^(?:[-–—]\s*){3,}$/;
const EMPTY_PARAGRAPH = /<p\b[^>]*>(?:\s|&nbsp;|&#160;|\u00a0|<br\s*\/?>)*<\/p>/i;
const PLAIN_EMPTY_PARAGRAPH = /\n[ \t]*\r?\n[ \t]*\r?\n/;
const DIALOGUE_START = /^[-–—―"'«»„“”‘’‹›]/;

function wordCount(text: string): number {
  return text === '' ? 0 : text.split(/\s+/).length;
}

/** Строки оболочки между блоками: `gaps[n]` - перед блоком `n`. */
function gapsBefore(layout: Pick<ChapterLayout, 'parts'>): Map<number, string> {
  const gaps = new Map<number, string>();
  let pending = '';
  for (const part of layout.parts) {
    if (typeof part === 'string') {
      pending += part;
    } else {
      gaps.set(part, pending);
      pending = '';
    }
  }
  return gaps;
}

function describe(layout: Pick<ChapterLayout, 'blocks' | 'parts' | 'format'>): Info[] {
  const gaps = gapsBefore(layout);
  const emptyParagraph = layout.format === 'plain' ? PLAIN_EMPTY_PARAGRAPH : EMPTY_PARAGRAPH;
  return layout.blocks.map((block) => {
    const text = block.translatable ? richHtmlText(block.html) : '';
    const marker = block.kind === 'hr' || SCENE_MARK.test(text);
    return {
      n: block.n,
      // Разделитель сцены - не текст для перевода по объёму.
      words: marker ? 0 : wordCount(text),
      text,
      // Сцена кончается после разделителя или перед пустым абзацем, который идёт за блоком.
      scene: marker || emptyParagraph.test(gaps.get(block.n + 1) ?? ''),
      dialogue: block.translatable && DIALOGUE_START.test(text),
    };
  });
}

/**
 * Запасная граница кодом: допустимый кандидат (не перед репликой), ближайший к середине
 * коридора; допустимых нет - ближайший из всех.
 */
export function fallbackBoundary(window: ContestedWindow): number {
  const target = (CHUNK_MIN_WORDS + CHUNK_MAX_WORDS) / 2;
  const allowed = window.candidates.filter((c) => !c.beforeDialogue);
  const pool = allowed.length > 0 ? allowed : window.candidates;
  let best = pool[0];
  for (const c of pool) {
    if (Math.abs(c.words - target) < Math.abs(best.words - target)) best = c;
  }
  return best.block;
}

/**
 * Куски главы по порядку. `pick` выбирает границу спорного стыка (номер блока из кандидатов);
 * ответ вне кандидатов заменяется запасной границей кодом. Глава не длиннее `CHUNK_MAX_WORDS` -
 * один кусок; блок длиннее коридора - кусок сам по себе (внутри блока граница не ставится).
 */
export async function planChunks(
  layout: Pick<ChapterLayout, 'blocks' | 'parts' | 'format'>,
  pick: (window: ContestedWindow) => Promise<number> = (w) => Promise.resolve(fallbackBoundary(w)),
): Promise<ChapterChunk[]> {
  const info = describe(layout);
  const chunks: ChapterChunk[] = [];
  let start = 0;
  while (start < info.length) {
    const rest = info.slice(start).reduce((sum, b) => sum + b.words, 0);
    if (rest <= CHUNK_MAX_WORDS) {
      chunks.push(chunkOf(info, start, info.length));
      break;
    }
    const end = await boundary(info, start, rest, pick);
    chunks.push(chunkOf(info, start, end));
    start = end;
  }
  return chunks;
}

/**
 * Шаг нарезки по сохранённым выборам `split` (сравнение `F05-3`, запуск `F05-4`): глава
 * проходится заново, известные стыки берутся из `picks` (ключ - первый кандидат окна).
 * Первый неизвестный стык - `open`: его выбирает модель следующим вызовом, и выбор пишется до
 * конца шага, поэтому повтор после обрыва его не оплачивает. Неизвестных нет - `chunks`.
 */
export async function nextSplit(
  layout: Pick<ChapterLayout, 'blocks' | 'parts' | 'format'>,
  picks: Readonly<Record<string, number>>,
): Promise<{ open: { key: string; window: ContestedWindow } } | { chunks: ChapterChunk[] }> {
  let open: { key: string; window: ContestedWindow } | null = null;
  const chunks = await planChunks(layout, (window) => {
    const key = String(window.candidates[0].block);
    if (key in picks) return Promise.resolve(picks[key]);
    open ??= { key, window };
    // Дальше по главе этот проход не пишется: стык выбирается моделью следующим шагом.
    return Promise.resolve(fallbackBoundary(window));
  });
  const pending = open as { key: string; window: ContestedWindow } | null;
  return pending ? { open: pending } : { chunks };
}

function chunkOf(info: Info[], start: number, end: number): ChapterChunk {
  return {
    firstBlock: info[start].n,
    lastBlock: info[end - 1].n,
    words: info.slice(start, end).reduce((sum, b) => sum + b.words, 0),
  };
}

/** Индекс первого блока следующего куска. */
async function boundary(
  info: Info[],
  start: number,
  rest: number,
  pick: (window: ContestedWindow) => Promise<number>,
): Promise<number> {
  const window: Array<BoundaryCandidate & { index: number; scene: boolean }> = [];
  let words = 0;
  for (let i = start; i < info.length - 1; i++) {
    words += info[i].words;
    if (words > CHUNK_MAX_WORDS) break;
    // Хвост после границы не короче коридора: иначе последний кусок вышел бы обрывком.
    if (words >= CHUNK_MIN_WORDS && rest - words >= CHUNK_MIN_WORDS) {
      const next = info[i + 1];
      window.push({
        index: i + 1,
        block: next.n,
        words,
        beforeDialogue: next.dialogue,
        head: next.text.split(/\s+/).slice(0, HEAD_WORDS).join(' '),
        scene: info[i].scene,
      });
    }
  }
  if (window.length === 0) return firstOverflow(info, start);
  const target = (CHUNK_MIN_WORDS + CHUNK_MAX_WORDS) / 2;
  const scenes = window.filter((c) => c.scene && !c.beforeDialogue);
  if (scenes.length > 0) {
    const best = scenes.reduce((a, c) =>
      Math.abs(c.words - target) < Math.abs(a.words - target) ? c : a,
    );
    return best.index;
  }
  const candidates = window.map(({ block, words: w, beforeDialogue, head }) => ({
    block,
    words: w,
    beforeDialogue,
    head,
  }));
  const answer = await pick({ candidates });
  const chosen = window.find((c) => c.block === answer);
  // Ответ вне окна или перед репликой при допустимых кандидатах - граница кодом: правило
  // «реплика не отрывается» держит код, а не промпт (карточка `F05-3`, шаг 1).
  const allowed = window.some((c) => !c.beforeDialogue);
  if (chosen && !(chosen.beforeDialogue && allowed)) return chosen.index;
  const fallback = fallbackBoundary({ candidates });
  return (window.find((c) => c.block === fallback) ?? window[0]).index;
}

/**
 * Окно пустое: коридор не помещается между блоками (длинный блок). Кусок кончается на блоке,
 * с которым он впервые дотягивает до нижней границы; хвост короче коридора берётся целиком.
 */
function firstOverflow(info: Info[], start: number): number {
  let words = 0;
  for (let i = start; i < info.length; i++) {
    // Блок длиннее коридора идёт куском сам по себе, а не склейкой с короткими перед ним.
    if (words > 0 && words + info[i].words > CHUNK_MAX_WORDS) return i;
    words += info[i].words;
    if (words >= CHUNK_MIN_WORDS) return i + 1;
  }
  return info.length;
}
