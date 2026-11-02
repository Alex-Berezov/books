/**
 * Дословность цитат - общая для заготовки Analysis (`F05-11`, решения арбитра `F05 | F05-11`,
 * Р5-Р7, Р20, Р21) и код-проверки `QUOTE_NOT_VERBATIM` пересказа и анализа (`F06`, `F07`;
 * `features/F06-summary-autofill/product.md` §3). Вынесено из `content-draft.analysis.ts`
 * без смены поведения (`F06-1`).
 */

/**
 * Нормализация дословности (Р5): пробелы любого вида (NBSP, переводы строк) - один пробел,
 * кавычки - прямые. Регистр, диакритика, тире и многоточие не трогаются.
 */
export function normalizeQuote(text: string): string {
  return text
    .replace(/[«»“”„‟"]/g, '"')
    .replace(/[‘’‚‛']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Абзац главы: исходный текст и его нормализованный вид с картой позиций в исходный. */
export interface IndexedParagraph {
  raw: string;
  norm: string;
  /** `at[i]` - позиция символа `norm[i]` в `raw`. */
  at: number[];
}

/** Глава для сверки цитат: абзацы текста `htmlToParagraphs` (Р21 - цитата внутри одного абзаца). */
export type ChapterIndex = ReadonlyMap<number, readonly IndexedParagraph[]>;

/**
 * Нормализованный вид абзаца с картой позиций (Р20): `normalizeQuote` меняет кавычки 1:1,
 * схлопывает пробелы и обрезает края - карта ведёт каждый символ результата в исходный текст.
 */
function indexParagraph(raw: string): IndexedParagraph {
  let norm = '';
  const at: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (norm !== '' && !norm.endsWith(' ')) {
        norm += ' ';
        at.push(i);
      }
      continue;
    }
    norm += normalizeQuote(ch) || ch;
    at.push(i);
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    at.pop();
  }
  return { raw, norm, at };
}

/**
 * Абзацы текста: по пустой строке, как их пишет `htmlToParagraphs`. Одно правило абзаца на сверку
 * цитат (Р21 - цитата внутри одного абзаца) и код-проверки чистовика (`text-checks.ts`).
 */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** Главы версии для сверки: абзацы `paragraphsOf`. */
export function indexChapters(chapters: ReadonlyMap<number, string>): ChapterIndex {
  return new Map(
    [...chapters].map(([number, text]) => [number, paragraphsOf(text).map(indexParagraph)]),
  );
}

/**
 * Фрагмент абзаца, в котором цитата стоит целиком после нормализации (Р21), - как в читалке
 * (Р20); `null` - не нашлась ни в одном абзаце.
 */
export function findVerbatim(text: string, paragraphs: Iterable<IndexedParagraph>): string | null {
  const quote = normalizeQuote(text);
  if (quote === '') return null;
  for (const p of paragraphs) {
    const start = p.norm.indexOf(quote);
    if (start < 0) continue;
    const end = p.at[start + quote.length - 1] + 1;
    return p.raw.slice(p.at[start], end).trim();
  }
  return null;
}

/** Почему цитата не прошла сверку по главе. */
export const QUOTE_CHECK_REASONS = ['NOT_FOUND', 'NO_CHAPTER', 'CHAPTER_MISSING'] as const;
export type QuoteCheckReason = (typeof QUOTE_CHECK_REASONS)[number];

/**
 * Проверка цитаты по главе (Р5, Р6, Р21): цитата целиком внутри одного абзаца указанной главы
 * после нормализации. Нашлась - отдаётся фрагмент главы, а не текст модели (Р20): кавычки
 * и пробелы цитаты - как в читалке. Фрагмент длиннее `maxLength` из-за пробельных серий главы -
 * те же символы со схлопнутыми пробелами (Р25).
 */
export function quoteInChapter(
  text: string,
  chapter: number,
  chapters: ChapterIndex,
  maxLength: number,
): { text: string } | { reason: QuoteCheckReason } {
  if (chapter <= 0) return { reason: 'NO_CHAPTER' };
  const paragraphs = chapters.get(chapter);
  if (paragraphs === undefined) return { reason: 'CHAPTER_MISSING' };
  const fragment = findVerbatim(text, paragraphs);
  if (fragment === null) return { reason: 'NOT_FOUND' };
  return { text: fragment.length > maxLength ? fragment.replace(/\s+/g, ' ').trim() : fragment };
}
