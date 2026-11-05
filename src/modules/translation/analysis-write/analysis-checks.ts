import { Language } from '@prisma/client';
import { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { computeAnalysisCore } from '../../book-analysis/book-analysis-core';
import {
  BOOK_ANALYSIS_LIMITS,
  BookAnalysisQuoteDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import type { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import { NameEntry } from '../check/mechanical-check';
import { analysisImportErrors, quoteCheck } from '../content-draft/content-draft.analysis';
import { ChapterIndex } from '../draft-quality/quote-check';
import {
  checkJunk,
  checkLanguage,
  checkNames,
  codeRemark,
  DraftRemark,
} from '../draft-quality/text-checks';
import { DroppedQuote, StepBlocks, StepDraft, StepFix } from './analysis-write.data';

/**
 * Код-проверки хода анализа (`features/F07-analysis-autofill/tech.md` §3, `product.md` §3.2;
 * решение арбитра `F07 | F07-1`, В3). Две группы:
 *
 * - **правки без переделки** (`fixDraft`): цитата не дословно в своей главе - выброшена, хранится
 *   фрагмент главы (`QUOTE_NOT_VERBATIM`, Р20 `F05-11`); номер главы не из версии - снят
 *   (`CHAPTER_UNKNOWN`); элементов больше предела импорта - хвост отрезан (`LIMIT_OUT`);
 * - **замечания, которые зовут переделку** (`stepRemarks`): ответ не проходит DTO импорта или
 *   ссылки на слитом объекте (`IMPORT_INVALID`, путь поля), язык, имена и мусор - функции `F06-1`.
 *
 * `CORE_MISSING` - флаг шага 3 без переделки (`coreRemark`): анализ всё равно пишется.
 */

type Quoted = BookAnalysisQuoteDto;

/**
 * Цитата по главе: нашлась - фрагмент главы с номером; нет - `null` и строка в `dropped`.
 * Номер главы не из версии - тоже выброс (`CHAPTER_MISSING`): цитата без главы не сверяется (Р6).
 */
function verifyQuote(
  path: string,
  quote: Quoted,
  chapters: ChapterIndex,
  dropped: StepDraft['droppedQuotes'],
): Quoted | null {
  const chapter = quote.chapter ?? 0;
  const found = quoteCheck(quote.text, chapter, chapters);
  if ('text' in found) return { text: found.text, chapter };
  dropped.push({
    path,
    text: quote.text,
    chapter: chapter > 0 ? chapter : null,
    reason: found.reason,
  });
  return null;
}

/** Хвост списка сверх предела импорта - отрезан с причиной (`LIMIT_OUT`). */
function limited<T>(list: T[], max: number, path: string, fixes: StepFix[]): T[] {
  if (list.length <= max) return list;
  fixes.push({
    code: 'LIMIT_OUT',
    path,
    note: `${list.length - max} of ${list.length} cut: the import takes at most ${max}`,
  });
  return list.slice(0, max);
}

/** Номера глав не из версии сняты с элемента (`CHAPTER_UNKNOWN`); пусто - поля нет. */
function knownChapters(
  list: number[] | null | undefined,
  chapters: ChapterIndex,
  path: string,
  fixes: StepFix[],
): number[] | undefined {
  if (!list || list.length === 0) return undefined;
  const known = list.filter((n) => chapters.has(n));
  const unknown = list.filter((n) => !chapters.has(n));
  if (unknown.length > 0) {
    fixes.push({
      code: 'CHAPTER_UNKNOWN',
      path,
      note: `chapters ${unknown.join(', ')} are not in this version: removed`,
    });
  }
  const unique = [...new Set(known)];
  return unique.length > 0 ? unique : undefined;
}

/**
 * Правки кода до проверок (В3): цитаты всех мест анализа - через `quoteCheck`, главы - по главам
 * версии, пределы - по `BOOK_ANALYSIS_LIMITS`. Сначала сверка цитат, потом предел (Р19 `F05-11`):
 * выброшенная цитата места в пределе не занимает. Пустой после правок список - блока нет (Л4).
 */
export function fixDraft(
  blocks: StepBlocks,
  chapters: ChapterIndex,
): Pick<StepDraft, 'blocks' | 'droppedQuotes' | 'fixes'> {
  const droppedQuotes: StepDraft['droppedQuotes'] = [];
  const fixes: StepFix[] = [];
  const LIMITS = BOOK_ANALYSIS_LIMITS;
  const out: StepBlocks = { ...blocks };

  if (blocks.characters) {
    const characters = blocks.characters.map((c) => {
      const next = { ...c };
      if (c.quote) {
        const quote = verifyQuote(`characters.${c.key}.quote`, c.quote, chapters, droppedQuotes);
        if (quote) next.quote = quote;
        else delete next.quote;
      }
      if (c.relations) {
        next.relations = limited(
          c.relations,
          LIMITS.relations,
          `characters.${c.key}.relations`,
          fixes,
        );
      }
      if (c.themeKeys) {
        next.themeKeys = limited(
          c.themeKeys,
          LIMITS.themeKeys,
          `characters.${c.key}.themeKeys`,
          fixes,
        );
      }
      return next;
    });
    out.characters = limited(characters, LIMITS.characters, 'characters', fixes);
  }

  if (blocks.keyQuotes) {
    const keyQuotes = blocks.keyQuotes.flatMap((q, i) => {
      const quote = verifyQuote(`keyQuotes.${i}`, q, chapters, droppedQuotes);
      return quote ? [{ ...q, ...quote }] : [];
    });
    out.keyQuotes = limited(keyQuotes, LIMITS.keyQuotes, 'keyQuotes', fixes);
  }

  if (blocks.style) {
    const style = blocks.style.map((s, i) => {
      const next = { ...s };
      if (s.example) {
        const example = verifyQuote(`style.${i}.example`, s.example, chapters, droppedQuotes);
        if (example) next.example = example;
        else delete next.example;
      }
      return next;
    });
    out.style = limited(style, LIMITS.style, 'style', fixes);
  }

  if (blocks.themes) {
    const themes = blocks.themes.map((theme) => {
      const next = { ...theme };
      const known = knownChapters(theme.chapters, chapters, `themes.${theme.key}.chapters`, fixes);
      if (known)
        next.chapters = limited(known, LIMITS.chapters, `themes.${theme.key}.chapters`, fixes);
      else delete next.chapters;
      if (theme.quotes) {
        const quotes = theme.quotes.flatMap((q, j) => {
          const quote = verifyQuote(`themes.${theme.key}.quotes.${j}`, q, chapters, droppedQuotes);
          return quote ? [{ ...q, ...quote }] : [];
        });
        const kept = limited(quotes, LIMITS.themeQuotes, `themes.${theme.key}.quotes`, fixes);
        if (kept.length > 0) next.quotes = kept;
        else delete next.quotes;
      }
      return next;
    });
    out.themes = limited(themes, LIMITS.themes, 'themes', fixes);
  }

  if (blocks.symbols) {
    const symbols = blocks.symbols.map((s, i) => {
      const next = { ...s };
      const known = knownChapters(s.chapters, chapters, `symbols.${i}.chapters`, fixes);
      if (known) next.chapters = limited(known, LIMITS.chapters, `symbols.${i}.chapters`, fixes);
      else delete next.chapters;
      if (s.quote) {
        const quote = verifyQuote(`symbols.${i}.quote`, s.quote, chapters, droppedQuotes);
        if (quote) next.quote = quote;
        else delete next.quote;
      }
      return next;
    });
    out.symbols = limited(symbols, LIMITS.symbols, 'symbols', fixes);
  }

  // Шаги 4-5: пределы импорта; пределы `timeline` и `adaptations` режет разбор ответа вместе со
  // ссылками на источники (`readExternal`).
  if (blocks.misreadings) {
    out.misreadings = limited(blocks.misreadings, LIMITS.misreadings, 'misreadings', fixes);
  }
  if (blocks.discussionQuestions) {
    out.discussionQuestions = limited(
      blocks.discussionQuestions,
      LIMITS.discussionQuestions,
      'discussionQuestions',
      fixes,
    );
  }
  if (blocks.faq) out.faq = limited(blocks.faq, LIMITS.faq, 'faq', fixes);
  if (blocks.sources) out.sources = limited(blocks.sources, LIMITS.sources, 'sources', fixes);

  for (const key of [
    'characters',
    'keyQuotes',
    'style',
    'themes',
    'symbols',
    'misreadings',
    'discussionQuestions',
    'faq',
    'timeline',
    'adaptations',
    'sources',
  ] as const) {
    if (out[key]?.length === 0) delete out[key];
  }
  return { blocks: out, droppedQuotes, fixes };
}

/** Тело импорта: итоги прошлых шагов, поверх - ответ шага; `facts` - поверх сохранённых подполей. */
function importBody(
  language: Language,
  stored: StoredBookAnalysis,
  merged: StepBlocks,
  blocks: StepBlocks,
): UpdateBookAnalysisDto {
  const body: StepBlocks = { ...merged, ...blocks };
  if (merged.facts || blocks.facts) {
    body.facts = { ...(stored.facts ?? {}), ...(merged.facts ?? {}), ...(blocks.facts ?? {}) };
  }
  return { language, ...body } as UpdateBookAnalysisDto;
}

/** Блок, к которому относится путь поля (`characters.0.name` → `characters`). */
export const blockOfPath = (path: string): string => path.split(/[.[:]/, 1)[0];

/**
 * `IMPORT_INVALID` (`tech.md` §3): DTO импорта и `checkAnalysisRefs` на **слитом** объекте -
 * ответ шага поверх итогов прошлых шагов поверх сохранённого анализа. В замечании - путь поля.
 * Только поля блоков этого шага: ошибки чужих блоков шаг не исправит.
 */
export function importRemarks(
  language: Language,
  stored: StoredBookAnalysis,
  merged: StepBlocks,
  blocks: StepBlocks,
): DraftRemark[] {
  const own = new Set(Object.keys(blocks));
  return analysisImportErrors(stored, importBody(language, stored, merged, blocks))
    .filter((error) => own.has(blockOfPath(error)))
    .map((error) => {
      const path = error.slice(0, error.indexOf(':'));
      return codeRemark(
        'IMPORT_INVALID',
        path,
        `The field ${error}. Fix this field or leave the element out.`,
      );
    });
}

/** Текстовое поле шага: путь, текст и длинный ли он (толкование, а не имя или подпись). */
interface TextField {
  path: string;
  text: string;
  long: boolean;
}

/** Текстовые поля блоков шага; цитаты не входят - их текст дословно из книги. */
function textFields(blocks: StepBlocks): TextField[] {
  const fields: TextField[] = [];
  const add = (path: string, text: string | null | undefined, long: boolean) => {
    if (typeof text === 'string' && text.trim() !== '') fields.push({ path, text, long });
  };
  for (const [key, value] of Object.entries(blocks.facts ?? {})) {
    add(`facts.${key}`, value as string | null, false);
  }
  add('mainIdea', blocks.mainIdea, true);
  add('titleMeaning', blocks.titleMeaning, true);
  add('endingMeaning', blocks.endingMeaning, true);
  add('context', blocks.context, true);
  add('reception', blocks.reception, true);
  (blocks.misreadings ?? []).forEach((m, i) => {
    add(`misreadings.${i}.myth`, m.myth, false);
    add(`misreadings.${i}.explanation`, m.explanation, true);
  });
  (blocks.discussionQuestions ?? []).forEach((q, i) => add(`discussionQuestions.${i}`, q, false));
  (blocks.faq ?? []).forEach((f, i) => {
    add(`faq.${i}.question`, f.question, false);
    add(`faq.${i}.answer`, f.answer, true);
  });
  (blocks.timeline ?? []).forEach((t, i) => add(`timeline.${i}.event`, t.event, false));
  (blocks.adaptations ?? []).forEach((a, i) => {
    add(`adaptations.${i}.title`, a.title, false);
    add(`adaptations.${i}.differences`, a.differences, true);
  });
  (blocks.sources ?? []).forEach((src, i) => add(`sources.${i}.title`, src.title, false));
  (blocks.characters ?? []).forEach((c) => {
    add(`characters.${c.key}.name`, c.name, false);
    add(`characters.${c.key}.description`, c.description, true);
    add(`characters.${c.key}.arc.from`, c.arc?.from, false);
    add(`characters.${c.key}.arc.to`, c.arc?.to, false);
    (c.relations ?? []).forEach((r, j) =>
      add(`characters.${c.key}.relations.${j}.label`, r.label, false),
    );
  });
  (blocks.keyQuotes ?? []).forEach((q, i) =>
    add(`keyQuotes.${i}.interpretation`, q.interpretation, true),
  );
  (blocks.style ?? []).forEach((s, i) => {
    add(`style.${i}.device`, s.device, false);
    add(`style.${i}.explanation`, s.explanation, true);
  });
  (blocks.themes ?? []).forEach((theme) => {
    add(`themes.${theme.key}.title`, theme.title, false);
    add(`themes.${theme.key}.interpretation`, theme.interpretation, true);
    (theme.quotes ?? []).forEach((q, j) =>
      add(`themes.${theme.key}.quotes.${j}.comment`, q.comment, false),
    );
  });
  (blocks.symbols ?? []).forEach((s, i) => {
    add(`symbols.${i}.title`, s.title, false);
    add(`symbols.${i}.interpretation`, s.interpretation, true);
  });
  return fields;
}

const WHERE_PATH_MAX = 80;

/** Место замечания - путь поля впереди: так флаг находит свой блок (`remarksOfTarget`). */
const atPath = (path: string, remark: DraftRemark): DraftRemark => {
  const where = `${path}: ${remark.where}`;
  return {
    ...remark,
    where: where.length > WHERE_PATH_MAX ? `${where.slice(0, WHERE_PATH_MAX - 1)}…` : where,
  };
};

/**
 * `LANGUAGE_MIXED`, `NAME_MISMATCH`, `JUNK` (`F06-1`) по текстовым полям шага. Служебные фразы
 * и Markdown - у всех полей; обрыв на полуслове - только у длинных: имя, подпись и строка
 * карточки - фраза, а не законченное предложение (решение арбитра `F07 | F07-1a`, Р10).
 */
export function textRemarks(
  blocks: StepBlocks,
  language: Language,
  glossary: readonly NameEntry[],
): DraftRemark[] {
  return textFields(blocks).flatMap((f) =>
    [
      ...checkJunk(f.text, { subheadings: false, breakOff: f.long }),
      ...checkLanguage(f.text, language, glossary),
      ...checkNames(f.text, language, glossary),
    ].map((r) => atPath(f.path, r)),
  );
}

/** Замечания кода шага, которые зовут переделку (В3). */
export function stepRemarks(input: {
  language: Language;
  stored: StoredBookAnalysis;
  merged: StepBlocks;
  draft: StepDraft;
  glossary: readonly NameEntry[];
}): DraftRemark[] {
  return [
    ...importRemarks(input.language, input.stored, input.merged, input.draft.blocks),
    ...textRemarks(input.draft.blocks, input.language, input.glossary),
  ];
}

/**
 * `CORE_MISSING` (`tech.md` §3; решение арбитра `F07 | F07-1a`, К5): ядро по **записанному** -
 * по сохранённому анализу, перечитанному после записи шага 3 (или после его окончательного
 * падения). Флаг без переделки; совпадает с `hasCore` записи (U6).
 */
export function coreRemark(stored: StoredBookAnalysis): DraftRemark | null {
  const core = computeAnalysisCore(stored);
  if (core.hasCore) return null;
  return codeRemark(
    'CORE_MISSING',
    'core',
    `The core is not complete: ${core.missing.map((m) => `${m.part} ${m.have} of ${m.need}`).join(', ')}.`,
  );
}

/** Выброшенные цитаты шага с номером шага - для `droppedQuotes` хода. */
export const stepDroppedQuotes = (
  step: DroppedQuote['step'],
  dropped: StepDraft['droppedQuotes'],
): DroppedQuote[] => dropped.map((d) => ({ step, ...d }));
