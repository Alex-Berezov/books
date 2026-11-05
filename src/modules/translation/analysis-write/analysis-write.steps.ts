import { createHash } from 'crypto';
import { Language, Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import type {
  BookAnalysisAdaptationDto,
  BookAnalysisCharacterDto,
  BookAnalysisFactsDto,
  BookAnalysisFaqDto,
  BookAnalysisMisreadingDto,
  BookAnalysisTimelineEventDto,
  BookAnalysisKeyQuoteDto,
  BookAnalysisStyleDto,
  BookAnalysisSymbolDto,
  BookAnalysisThemeDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import type { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { ANSWER_CHARS_PER_TOKEN, estimateInputTokens } from '../../llm/openrouter.client';
import { FILLABLE_FACTS } from '../content-draft/content-draft.analysis';
import { chaptersText } from '../content-draft/content-draft.text';
import { ShapedRequest } from '../dossier/dossier.prompts';
import { QualityLoopSpec } from '../draft-quality/quality-loop';
import { ChapterIndex, normalizeQuote } from '../draft-quality/quote-check';
import { StageModels } from '../run/run-models';
import { glossaryNames, glossaryText, PartContext } from '../summary-write/summary-write.parts';
import { fixDraft, stepRemarks } from './analysis-checks';
import { ANALYSIS_REVIEW_STAGE, EXTERNAL_STEP, READER_STEP } from './analysis-write.constants';
import { EXAMPLE_ANALYSES } from './examples';
import {
  AnalysisStepNumber,
  AnalysisTarget,
  blocksValue,
  pathInTarget,
  targetBlocks,
  withoutTarget,
  StepBlocks,
  EMPTY_DRAFT,
  EXTERNAL_FACTS,
  refIndexes,
  SourceRefs,
  StepDraft,
  StepSource,
  StepFix,
  ThemeLinks,
} from './analysis-write.data';
import {
  ANALYSIS_REVIEW_CODES,
  STEP_SHAPES,
  STEP_STAGES,
  StepRedo,
  StepRegen,
  stepReviewRequest,
  stepWriteRequest,
} from './analysis-write.prompts';

/**
 * Шаги хода анализа (`F07-1a`; `features/F07-analysis-autofill/tech.md` §2-§3): разбор ответа
 * модели в блоки импорта, входы автора и проверяющей и спецификация цикла качества - одной
 * сборкой на шаг обработчика и на оценку старта, чтобы оценка считала те же запросы.
 */

/** Отпечаток цитаты - хэш нормализованного текста (`tech.md` §2): позиция сдвигается правками кода. */
export const quotePrint = (text: string): string =>
  createHash('sha256').update(normalizeQuote(text)).digest('hex').slice(0, 12);

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const chapterNumber = (v: unknown): number => (Number.isInteger(v) ? (v as number) : 0);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** Цитата ответа: пустой текст - цитаты нет; глава `0` - без главы (сверка её выбросит). */
const quoteOf = (text: unknown, chapter: unknown) =>
  trimmed(text) === ''
    ? undefined
    : {
        text: trimmed(text),
        ...(chapterNumber(chapter) > 0 ? { chapter: chapterNumber(chapter) } : {}),
      };

/** Пустое поле ответа - поля нет: строгая форма шлёт `""`, а импорт пустую строку отбил бы. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== ''),
  ) as T;
}

function readCast(value: unknown): StepBlocks {
  const v = rec(value);
  const factsIn = rec(v.facts);
  const facts: BookAnalysisFactsDto = {};
  for (const field of FILLABLE_FACTS) {
    const text = trimmed(factsIn[field]);
    if (text !== '') facts[field] = text;
  }
  const characters = list(v.characters).map((raw) => {
    const c = rec(raw);
    const arcFrom = trimmed(c.arcFrom);
    const arcTo = trimmed(c.arcTo);
    const relations = list(c.relations)
      .map((r) => ({ to: trimmed(rec(r).to), label: trimmed(rec(r).label) }))
      .filter((r) => r.to !== '' && r.label !== '');
    return compact({
      key: trimmed(c.key),
      name: trimmed(c.name),
      role: trimmed(c.role),
      description: trimmed(c.description),
      arc: arcFrom !== '' && arcTo !== '' ? { from: arcFrom, to: arcTo } : undefined,
      quote: quoteOf(c.quote, c.quoteChapter),
      relations: relations.length > 0 ? relations : undefined,
    }) as unknown as BookAnalysisCharacterDto;
  });
  const out: StepBlocks = {};
  if (Object.keys(facts).length > 0) out.facts = facts;
  if (characters.length > 0) out.characters = characters;
  return out;
}

function readQuotes(value: unknown): StepBlocks {
  const v = rec(value);
  // Цитата без текста - не элемент (как у цитат тем): ни выброса без текста, ни слота предела.
  const keyQuotes = list(v.keyQuotes).flatMap((raw) => {
    const q = rec(raw);
    const quote = quoteOf(q.text, q.chapter);
    if (!quote) return [];
    return [
      compact({
        ...quote,
        speakerKey: trimmed(q.speakerKey),
        interpretation: trimmed(q.interpretation),
      }) as unknown as BookAnalysisKeyQuoteDto,
    ];
  });
  const style = list(v.style).map((raw) => {
    const s = rec(raw);
    return compact({
      device: trimmed(s.device),
      explanation: trimmed(s.explanation),
      example: quoteOf(s.example, s.exampleChapter),
    }) as unknown as BookAnalysisStyleDto;
  });
  const out: StepBlocks = {};
  if (keyQuotes.length > 0) out.keyQuotes = keyQuotes;
  if (style.length > 0) out.style = style;
  return out;
}

const chapterList = (v: unknown): number[] | undefined => {
  const numbers = list(v).filter((x): x is number => Number.isInteger(x) && (x as number) > 0);
  return numbers.length > 0 ? numbers : undefined;
};

function readMeaning(value: unknown): StepBlocks {
  const v = rec(value);
  const themes = list(v.themes).map((raw) => {
    const th = rec(raw);
    const quotes = list(th.quotes).flatMap((q) => {
      const quote = quoteOf(rec(q).text, rec(q).chapter);
      const comment = trimmed(rec(q).comment);
      return quote ? [compact({ ...quote, comment })] : [];
    });
    return compact({
      key: trimmed(th.key),
      title: trimmed(th.title),
      interpretation: trimmed(th.interpretation),
      chapters: chapterList(th.chapters),
      quotes: quotes.length > 0 ? quotes : undefined,
    }) as unknown as BookAnalysisThemeDto;
  });
  const symbols = list(v.symbols).map((raw) => {
    const s = rec(raw);
    return compact({
      title: trimmed(s.title),
      interpretation: trimmed(s.interpretation),
      chapters: chapterList(s.chapters),
      quote: quoteOf(s.quote, s.quoteChapter),
    }) as unknown as BookAnalysisSymbolDto;
  });
  const out: StepBlocks = {};
  for (const key of ['mainIdea', 'titleMeaning', 'endingMeaning'] as const) {
    const text = trimmed(v[key]);
    if (text !== '') out[key] = text;
  }
  if (themes.length > 0) out.themes = themes;
  if (symbols.length > 0) out.symbols = symbols;
  return out;
}

/** Шаг 4: ошибки понимания, вопросы для обсуждения и FAQ; пустые элементы не отдаются. */
function readReader(value: unknown): StepBlocks {
  const v = rec(value);
  const misreadings = list(v.misreadings).flatMap((raw) => {
    const m = rec(raw);
    const myth = trimmed(m.myth);
    const explanation = trimmed(m.explanation);
    return myth !== '' && explanation !== ''
      ? [{ myth, explanation } as BookAnalysisMisreadingDto]
      : [];
  });
  const discussionQuestions = list(v.discussionQuestions)
    .map(trimmed)
    .filter((q) => q !== '');
  const faq = list(v.faq).flatMap((raw) => {
    const f = rec(raw);
    const question = trimmed(f.question);
    const answer = trimmed(f.answer);
    return question !== '' && answer !== '' ? [{ question, answer } as BookAnalysisFaqDto] : [];
  });
  const out: StepBlocks = {};
  if (misreadings.length > 0) out.misreadings = misreadings;
  if (discussionQuestions.length > 0) out.discussionQuestions = discussionQuestions;
  if (faq.length > 0) out.faq = faq;
  return out;
}

/** Ссылки утверждения в индексах списка источников после разбора: выброшенный источник - не ссылка. */
const remapRefs = (v: unknown, remap: ReadonlyMap<number, number>): number[] =>
  refIndexes(v).flatMap((n) => (remap.has(n) ? [remap.get(n) as number] : []));

/**
 * Абзацы `context`/`reception`: текст склеивается пустой строкой, ссылки остаются по абзацам.
 * Пустая строка внутри абзаца ответа делит его на абзацы с теми же ссылками: иначе разбиение
 * склеенного текста при проверке источников (`verifyExternal`) сдвинуло бы ссылки абзацев.
 */
function readParagraphs(
  value: unknown,
  remap: ReadonlyMap<number, number>,
): { text: string; refs: number[][] } {
  const rows = list(value)
    .map(rec)
    .flatMap((r) => {
      const refs = remapRefs(r.refs, remap);
      return trimmed(r.text)
        .split(/\n\s*\n/)
        .map((text) => text.trim())
        .filter((text) => text !== '')
        .map((text) => ({ text, refs }));
    });
  return { text: rows.map((r) => r.text).join('\n\n'), refs: rows.map((r) => r.refs) };
}

/**
 * Источники ответа без пустых и карта «индекс ответа → индекс после разбора»: ссылки утверждений
 * считаются по списку ответа, а выброшенный пустой источник не должен сдвигать остальные.
 */
function readSources(value: unknown): {
  sources: Array<{ title: string; url: string }>;
  remap: Map<number, number>;
} {
  const sources: Array<{ title: string; url: string }> = [];
  const remap = new Map<number, number>();
  list(value).forEach((raw, i) => {
    const x = rec(raw);
    if (trimmed(x.title) === '' || trimmed(x.url) === '') return;
    remap.set(i, sources.length);
    sources.push({ title: trimmed(x.title), url: trimmed(x.url) });
  });
  return { sources, remap };
}

/** Хвост списка сверх предела с ссылками по месту: отрезается вместе (`LIMIT_OUT`). */
function cut<T>(
  rows: T[],
  refs: number[][],
  max: number,
  path: string,
  fixes: StepFix[],
): { rows: T[]; refs: number[][] } {
  if (rows.length <= max) return { rows, refs };
  fixes.push({
    code: 'LIMIT_OUT',
    path,
    note: `${rows.length - max} of ${rows.length} cut: the import takes at most ${max}`,
  });
  return { rows: rows.slice(0, max), refs: refs.slice(0, max) };
}

/**
 * Шаг 5: внешние блоки и ссылки утверждений на `sources` (`tech.md` §4). Ссылки идут в `refs`
 * отдельно от блоков - в импорт они не уходят. Пределы `timeline` и `adaptations` режутся здесь,
 * вместе со ссылками, чтобы те не разъехались с элементами.
 */
function readExternal(value: unknown, fixes: StepFix[]): { blocks: StepBlocks; refs: SourceRefs } {
  const v = rec(value);
  const { sources, remap } = readSources(v.sources);
  const refs: SourceRefs = { facts: {}, context: [], reception: [], timeline: [], adaptations: [] };
  const facts: BookAnalysisFactsDto = {};
  for (const field of EXTERNAL_FACTS) {
    const text = trimmed(v[field]);
    if (text === '') continue;
    facts[field] = text;
    refs.facts[field] = remapRefs(v[`${field}Refs`], remap);
  }
  const context = readParagraphs(v.context, remap);
  const reception = readParagraphs(v.reception, remap);
  refs.context = context.refs;
  refs.reception = reception.refs;
  const timelineRows = list(v.timeline)
    .map(rec)
    .flatMap((t) => {
      const year = trimmed(t.year);
      const event = trimmed(t.event);
      return year !== '' && event !== ''
        ? [
            {
              row: { year, event, kind: t.kind } as unknown as BookAnalysisTimelineEventDto,
              refs: remapRefs(t.refs, remap),
            },
          ]
        : [];
    });
  const timeline = cut(
    timelineRows.map((r) => r.row),
    timelineRows.map((r) => r.refs),
    BOOK_ANALYSIS_LIMITS.timeline,
    'timeline',
    fixes,
  );
  const adaptationRows = list(v.adaptations)
    .map(rec)
    .flatMap((a) => {
      const title = trimmed(a.title);
      const year = Number.isInteger(a.year) ? (a.year as number) : 0;
      const { min, max } = BOOK_ANALYSIS_LIMITS.adaptationYear;
      // Не уверен в годе - экранизации нет (канон `F03`, «adaptations»): без года не пишется.
      if (title === '' || year < min || year > max) return [];
      return [
        {
          row: compact({
            title,
            year,
            kind: a.kind,
            differences: trimmed(a.differences),
          }) as unknown as BookAnalysisAdaptationDto,
          refs: remapRefs(a.refs, remap),
        },
      ];
    });
  const adaptations = cut(
    adaptationRows.map((r) => r.row),
    adaptationRows.map((r) => r.refs),
    BOOK_ANALYSIS_LIMITS.adaptations,
    'adaptations',
    fixes,
  );
  refs.timeline = timeline.refs;
  refs.adaptations = adaptations.refs;
  const blocks: StepBlocks = {};
  if (Object.keys(facts).length > 0) blocks.facts = facts;
  if (context.text !== '') blocks.context = context.text;
  if (timeline.rows.length > 0) blocks.timeline = timeline.rows;
  if (reception.text !== '') blocks.reception = reception.text;
  if (adaptations.rows.length > 0) blocks.adaptations = adaptations.rows;
  if (sources.length > 0) blocks.sources = sources;
  return { blocks, refs };
}

/** На что вправе ссылаться связи шага 3: герои и цитаты входа (`id` - отпечаток). */
export interface LinkTargets {
  characterKeys: ReadonlySet<string>;
  quoteIds: ReadonlySet<string>;
  /** Ключи тем сохранённого анализа: на них ссылаться тоже можно. */
  storedThemeKeys: ReadonlySet<string>;
}

/**
 * Связи тем шага 3 (`tech.md` §2): героя и цитату не из входа, тему не из ответа и не из
 * сохранённого - выброс с причиной (`IMPORT_INVALID` правкой кода, без переделки).
 */
function readLinks(
  value: unknown,
  themes: readonly BookAnalysisThemeDto[],
  targets: LinkTargets,
  fixes: StepFix[],
): ThemeLinks {
  const links = rec(rec(value).themeLinks);
  const themeKeys = new Set([...themes.map((th) => th.key), ...targets.storedThemeKeys]);
  const pick = (
    raw: unknown,
    idField: 'key' | 'id',
    known: ReadonlySet<string>,
    block: string,
  ): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const entry of list(raw)) {
      const id = trimmed(rec(entry)[idField]);
      if (!known.has(id)) {
        fixes.push({
          code: 'IMPORT_INVALID',
          path: `themeLinks.${block}.${id}`,
          note: `"${id}" is not in the input of the step: the link is dropped`,
        });
        continue;
      }
      const keys = list(rec(entry).themeKeys).map(trimmed);
      const good = [...new Set(keys.filter((k) => themeKeys.has(k)))];
      const bad = keys.filter((k) => !themeKeys.has(k));
      if (bad.length > 0) {
        fixes.push({
          code: 'IMPORT_INVALID',
          path: `themeLinks.${block}.${id}`,
          note: `unknown theme keys ${bad.map((k) => `"${k}"`).join(', ')}: dropped`,
        });
      }
      if (good.length > 0) out[id] = [...new Set([...(out[id] ?? []), ...good])];
    }
    return out;
  };
  return {
    characters: pick(links.characters, 'key', targets.characterKeys, 'characters'),
    keyQuotes: pick(links.keyQuotes, 'id', targets.quoteIds, 'keyQuotes'),
  };
}

/** Разбор ответа шага по тексту книги и шага для читателя; внешний шаг - `readExternal` со ссылками. */
const STEP_READERS: Record<Exclude<AnalysisStepNumber, 5>, (value: unknown) => StepBlocks> = {
  1: readCast,
  2: readQuotes,
  3: readMeaning,
  4: readReader,
};

/** Ответ шага → блоки импорта; язык ставит код (Л5), пустые блоки не отдаются (Л4). */
export function readStepAnswer(
  step: AnalysisStepNumber,
  value: unknown,
  chapters: ChapterIndex,
  targets: LinkTargets,
): StepDraft {
  const readFixes: StepFix[] = [];
  let refs: SourceRefs | null = null;
  let raw: StepBlocks;
  if (step === EXTERNAL_STEP) {
    const external = readExternal(value, readFixes);
    raw = external.blocks;
    refs = external.refs;
  } else {
    raw = STEP_READERS[step](value);
  }
  const fixed = fixDraft(raw, chapters);
  fixed.fixes.unshift(...readFixes);
  const themeLinks =
    step === 3 ? readLinks(value, fixed.blocks.themes ?? [], targets, fixed.fixes) : null;
  return { ...fixed, themeLinks, refs };
}

/**
 * Ответ шага, сведённый к одному блоку перегенерации (`F07-1b`): прочие блоки отброшены, как их
 * выброшенные цитаты и правки кода; связи тем - только у шага 3, перегенерации его блоков нет.
 */
export function onlyTarget(draft: StepDraft, target: AnalysisTarget): StepDraft {
  const blocks = targetBlocks(target, blocksValue(draft.blocks, target));
  // Путь блока `facts` целиком относится и к его подполю (правило одно - `pathInTarget`).
  const own = (path: string) => pathInTarget(path, target);
  return {
    blocks,
    themeLinks: null,
    refs: null,
    droppedQuotes: draft.droppedQuotes.filter((d) => own(d.path)),
    fixes: draft.fixes.filter((f) => own(f.path)),
  };
}

/** Книга шага: весь текст версии или краткое содержание глав досье (`tech.md` §2). */
interface StepBook {
  text: string;
  isSummaries: boolean;
}

/** Всё, из чего строится шаг: общее у обработчика и оценки. */
export interface StepContext extends PartContext {
  bookTitle: string;
  author: string;
  stored: StoredBookAnalysis;
  merged: StepBlocks;
  chapters: ReadonlyArray<{ number: number; title: string; content: string }>;
  /** Ключи анализа этой книги на другом языке (U7) - строкой для промпта. */
  otherKeys: string;
  /**
   * Названия книги и имена авторов всех её версий - чем страница источника подтверждает, что она
   * про эту книгу (название на языке версии или оригинала, фамилия автора; `product.md` §3.3).
   */
  names?: { titles: string[]; authors: string[] };
  /** Язык оригинала книги (`BookVersion.originalLanguage`) - вход внешнего шага (`tech.md` §2). */
  originalLanguage?: string;
}

interface DossierChapters {
  chapters?: Array<{ number?: unknown; title?: unknown; summary?: unknown }>;
}

/** Текст версии для шага: главы с меткой читалки. */
export const versionBook = (context: StepContext): StepBook => ({
  text: chaptersText(context.chapters),
  isSummaries: false,
});

/** Шагу 5 книгу не дают: он пишет по названию, автору и итогу шага 3 (`tech.md` §2). */
const NO_BOOK: StepBook = { text: 'none', isSummaries: false };

/**
 * Книга шага (`tech.md` §2): шагам 1-3 - весь текст версии, шагу 4 - краткое содержание глав
 * досье, шагу 5 - ничего. Краткое содержание глав досье влезает всегда, когда влезает досье.
 */
export function bookFor(step: AnalysisStepNumber, context: StepContext): StepBook {
  if (step === EXTERNAL_STEP) return NO_BOOK;
  return step === READER_STEP ? summariesBook(context) : versionBook(context);
}

/**
 * Краткое содержание глав досье - когда текст не влезает во вход (`product.md` §6); за ним -
 * текст глав `chapters` версии (`[READER CHAPTER n]`), на которые ссылаются прошлые шаги.
 */
function summariesBook(context: StepContext, chapters: readonly number[] = []): StepBook {
  const lines = ((context.dossier ?? {}) as DossierChapters).chapters ?? [];
  const summaries =
    lines
      .map(
        (c) =>
          `[CHAPTER ${typeof c.number === 'number' ? c.number : '?'}] ${trimmed(c.title)}\n${trimmed(c.summary)}`,
      )
      .join('\n\n') || 'none';
  const own = chapters.flatMap((n) => context.chapters.filter((c) => c.number === n));
  return {
    text: own.length > 0 ? `${summaries}\n\n${chaptersText(own)}` : summaries,
    isSummaries: true,
  };
}

/**
 * Главы, на которые ссылаются итоги прошлых шагов (решение арбитра `F07 | F07-1a`, Р8): шагу 2 -
 * главы цитат героев шага 1, шагу 3 - главы цитат шагов 1-2 и номера `chapters`; шагу 1 - нет.
 * По порядку первого упоминания, без повторов, только главы версии.
 */
export function referencedChapters(step: AnalysisStepNumber, context: StepContext): number[] {
  if (step === 1 || step >= 4) return [];
  const m = context.merged;
  const mentions: Array<number | null | undefined> = (m.characters ?? []).map(
    (c) => c.quote?.chapter,
  );
  if (step === 3) {
    mentions.push(
      ...(m.keyQuotes ?? []).map((q) => q.chapter),
      ...(m.style ?? []).map((st) => st.example?.chapter),
      ...(m.themes ?? []).flatMap((th) => [
        ...(th.chapters ?? []),
        ...(th.quotes ?? []).map((q) => q.chapter),
      ]),
      ...(m.symbols ?? []).flatMap((sy) => [...(sy.chapters ?? []), sy.quote?.chapter]),
    );
  }
  const known = new Set(context.chapters.map((c) => c.number));
  const out: number[] = [];
  for (const number of mentions) {
    if (typeof number === 'number' && known.has(number) && !out.includes(number)) {
      out.push(number);
    }
  }
  return out;
}

/**
 * Вход шага, который влезает (`tech.md` §2, `product.md` §6; Р8): весь текст версии; не влез -
 * краткое содержание глав досье и наибольший префикс глав `referencedChapters`, который `fits`
 * пропускает (поиск делением пополам: вход растёт с числом глав); не влезло и краткое
 * содержание - `null` (`DRAFT_TOO_LONG`).
 */
export async function fitStepInput(
  step: AnalysisStepNumber,
  context: StepContext,
  quotes: ChapterIndex,
  fits: (input: StepInput) => Promise<boolean>,
  regen: StepRegen | null = null,
): Promise<{ input: StepInput; source: StepSource } | null> {
  // Шаги 4-5 текста версии не читают: вход один, и он либо влезает, либо `DRAFT_TOO_LONG`.
  if (step >= 4) {
    const only = stepInput(step, context, bookFor(step, context), quotes, regen);
    return (await fits(only))
      ? { input: only, source: step === READER_STEP ? 'summaries' : 'none' }
      : null;
  }
  const whole = stepInput(step, context, versionBook(context), quotes, regen);
  if (await fits(whole)) return { input: whole, source: 'text' };
  const chapters = referencedChapters(step, context);
  const withChapters = (count: number) =>
    stepInput(step, context, summariesBook(context, chapters.slice(0, count)), quotes, regen);
  let best = withChapters(0);
  if (!(await fits(best))) return null;
  let low = 0;
  let high = chapters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = withChapters(middle);
    if (await fits(candidate)) {
      low = middle;
      best = candidate;
    } else {
      high = middle - 1;
    }
  }
  return { input: best, source: 'summaries' };
}

/**
 * Влезает ли вход шага (Р8 и поправка арбитра `F07 | F07-1a` к п.1 круга /fix 1): запрос автора -
 * `stageFit` его этапа; запрос проверяющей - с ответом автора, которого ещё нет: пустой ответ плюс
 * сверху `maxTokens` автора в символах по оценке длины ответа сверху (`ANSWER_CHARS_PER_TOKEN`, решение
 * арбитра `F07 | F07-1a`, круг /fix 2) против границы этапа проверяющей. Иначе проверяющая отпала бы `too_long` после оплаченного шага автора.
 */
export async function stepInputFits(
  llm: Pick<LlmService, 'stageFit' | 'stageInputCeiling' | 'getStageSetting'>,
  input: StepInput,
): Promise<boolean> {
  const stage = STEP_STAGES[input.step];
  if (!(await llm.stageFit(stage, input.author(null))).fits) return false;
  const [{ maxInputChars }, author] = await Promise.all([
    llm.stageInputCeiling(ANALYSIS_REVIEW_STAGE),
    llm.getStageSetting(stage),
  ]);
  if (maxInputChars === null) return true;
  const answer = author.maxTokens * ANSWER_CHARS_PER_TOKEN;
  return estimateInputTokens(input.review(EMPTY_DRAFT)) + answer <= maxInputChars;
}

/** Досье без глав (их краткое содержание - в книге шага, когда текст не влез). */
function dossierText(dossier: unknown): string {
  const d = rec(dossier);
  return JSON.stringify({
    characters: d.characters ?? [],
    entities: d.entities ?? [],
    setting: d.setting ?? null,
    narration: d.narration ?? null,
    structure: d.structure ?? null,
    chronology: d.chronology ?? [],
    motifs: d.motifs ?? [],
  });
}

/** Ключи для промпта: сохранённые этой версии и анализа другого языка (U7). */
function keysText(context: StepContext): string {
  const own = [
    ...(context.stored.themes ?? []).map((th) => `theme ${th.key} - ${th.title}`),
    ...(context.stored.characters ?? []).map((c) => `character ${c.key} - ${c.name}`),
  ];
  const lines = [...own, ...(context.otherKeys === '' ? [] : [context.otherKeys])];
  return lines.length > 0 ? lines.join('\n') : 'none';
}

/** Герои хода и сохранённые - вход шагов 2 и 3 (ключи для `speakerKey` и связей). */
function castOf(context: StepContext): BookAnalysisCharacterDto[] {
  const own = context.merged.characters ?? [];
  const stored = (context.stored.characters ?? []).filter((c) => !own.some((o) => o.key === c.key));
  return [...own, ...stored];
}

/** Ключевые цитаты хода и сохранённые с отпечатком - вход шага 3. */
function quotesOf(context: StepContext): Array<{ id: string; text: string }> {
  const all = [...(context.merged.keyQuotes ?? []), ...(context.stored.keyQuotes ?? [])];
  const seen = new Set<string>();
  return all.flatMap((q) => {
    const id = quotePrint(q.text);
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, text: q.text }];
  });
}

/**
 * Итоги шагов 1-3 для шагов 4-5 (`tech.md` §2): шаг 4 видит итог шагов 1-3 - героев, ключевые
 * цитаты, символы, смысл названия и финала, главную мысль и темы с толкованием (на них опираются
 * ошибки понимания и FAQ), шаг 5 - главную мысль и темы названиями (контекст про то же).
 */
function laterPrevious(
  step: AnalysisStepNumber,
  context: StepContext,
): Array<readonly [string, string]> {
  const themes = context.merged.themes ?? context.stored.themes ?? [];
  const mainIdea = context.merged.mainIdea ?? context.stored.mainIdea ?? '';
  if (step === EXTERNAL_STEP) {
    return [
      ['MAIN_IDEA', mainIdea],
      ['THEMES', JSON.stringify(themes.map((th) => ({ key: th.key, title: th.title })))],
    ];
  }
  const m = context.merged;
  const s = context.stored;
  return [
    [
      'CHARACTERS',
      JSON.stringify(
        castOf(context).map((c) => ({
          key: c.key,
          name: c.name,
          role: c.role,
          description: c.description ?? '',
        })),
      ),
    ],
    [
      'KEY_QUOTES',
      JSON.stringify(
        (m.keyQuotes ?? s.keyQuotes ?? []).map((q) => ({
          text: q.text,
          interpretation: q.interpretation ?? '',
        })),
      ),
    ],
    [
      'SYMBOLS',
      JSON.stringify(
        (m.symbols ?? s.symbols ?? []).map((sy) => ({
          title: sy.title,
          interpretation: sy.interpretation ?? '',
        })),
      ),
    ],
    ['TITLE_MEANING', m.titleMeaning ?? s.titleMeaning ?? ''],
    ['ENDING_MEANING', m.endingMeaning ?? s.endingMeaning ?? ''],
    ['MAIN_IDEA', mainIdea],
    [
      'THEMES',
      JSON.stringify(
        themes.map((th) => ({
          key: th.key,
          title: th.title,
          interpretation: th.interpretation ?? '',
        })),
      ),
    ],
  ];
}

/** Итоги прошлых шагов для промпта шага. */
function previousOf(
  step: AnalysisStepNumber,
  context: StepContext,
): Array<readonly [string, string]> {
  if (step === 1) return [];
  if (step >= 4) return laterPrevious(step, context);
  const cast = JSON.stringify(
    castOf(context).map((c) => ({
      key: c.key,
      name: c.name,
      role: c.role,
      ...(step === 3 ? { description: c.description ?? '' } : {}),
    })),
  );
  if (step === 2) return [['CHARACTERS', cast]];
  return [
    ['CHARACTERS', cast],
    ['KEY_QUOTES', JSON.stringify(quotesOf(context))],
    ['STYLE', JSON.stringify(context.merged.style ?? context.stored.style ?? [])],
  ];
}

/**
 * Внешние факты эталона вне `ru` (решение арбитра `F07 | F07-1a`, финальный /qa после круга 3):
 * герои, чьё описание объясняет фамилию русским словом (Разумихин) или зовёт героя предком
 * психологического детектива (Порфирий); цитата, чьё толкование ссылается на русское название
 * романа; темы, чьё толкование объясняет фамилию героя словом `raskol` (`alienation`) или судит о восприятии читателями (`guilt`, «what surprises many readers»).
 */
const FOREIGN_FACT_CHARACTERS = ['razumikhin', 'porfiry'];
const FOREIGN_FACT_QUOTE_INDEX = 1;
/** Вопрос FAQ эталона о названии романа - индекс в `faq` эталона любого языка. */
const FOREIGN_FACT_FAQ_INDEX = 1;
const FOREIGN_FACT_THEMES: ReadonlySet<string> = new Set(['alienation', 'guilt']);
/** Приём эталона с топографией города («readers still walk them») - индекс в `style` канона языка. */
const TOPOGRAPHY_STYLE_INDEX: Partial<Record<Language, number>> = { en: 3, ru: 3 };
/** Факты шага 1 в срезе: без `settingTime`, в эталоне это год - промпт требует «No dates». */
const SLICE_FACTS = FILLABLE_FACTS.filter((f) => f !== 'settingTime');

const withoutRelationsTo = (
  character: Record<string, unknown>,
  keys: ReadonlySet<string>,
): Record<string, unknown> =>
  Array.isArray(character.relations)
    ? {
        ...character,
        relations: character.relations.filter((r) => !keys.has(trimmed(rec(r).to))),
      }
    : character;

const withoutThemeKeys = (list: unknown): unknown[] =>
  Array.isArray(list)
    ? list.map((element) =>
        Object.fromEntries(Object.entries(rec(element)).filter(([key]) => key !== 'themeKeys')),
      )
    : [];

/**
 * Срез эталона языка версии по блокам шага (решение арбитра `F07 | F07-1a`, К3): шагу 1 -
 * карточка шага и герои без `themeKeys`, шагу 2 - цитаты без `themeKeys` и приёмы, шагу 3 -
 * толкования. Целого эталона шаг не получает: блоки других шагов - не его форма. `titleMeaning`
 * эталона шагу 3 - только в `ru`: в остальных языках он объясняет игру слов русского оригинала,
 * внешний факт, который промпт шага снял (А1; решение арбитра `F07 | F07-1a`, срез эталона шага 3).
 * Тем же правилом (Б1, проверочный /qa после /fix 2): шагу 2 - приёмы без первого, «полифонии»
 * со ссылкой на Бахтина, шагу 1 вне `ru` - герои без Разумихина, чьё описание объясняет фамилию
 * русским словом `razum`; связи на выброшенного героя уходят вместе с ним - образец без висячих
 * ссылок, которые проверка ссылок (К4) отбила бы в ответе. Тем же правилом (финальный /qa после
 * круга 3): факты без `settingTime` на всех языках, приёмы без топографии города там, где она
 * есть; вне `ru` - герои без Порфирия, цитаты без второй, толкования без тем `alienation` и `guilt`.
 * Вырезаются только целые элементы и подполя: текст эталона не правится (А7).
 */
export function exampleSlice(step: AnalysisStepNumber, language: Language): string {
  const example = EXAMPLE_ANALYSES[language];
  if (step === 1) {
    const facts = rec(example.facts);
    const dropped = new Set(language === 'ru' ? [] : FOREIGN_FACT_CHARACTERS);
    return JSON.stringify({
      facts: Object.fromEntries(SLICE_FACTS.flatMap((f) => (f in facts ? [[f, facts[f]]] : []))),
      characters: withoutThemeKeys(example.characters)
        .filter((c) => !dropped.has(trimmed(rec(c).key)))
        .map((c) => withoutRelationsTo(rec(c), dropped)),
    });
  }
  if (step === 2) {
    return JSON.stringify({
      keyQuotes: withoutThemeKeys(example.keyQuotes).filter(
        (_, i) => language === 'ru' || i !== FOREIGN_FACT_QUOTE_INDEX,
      ),
      style: list(example.style).filter(
        (_, i) => i !== 0 && i !== TOPOGRAPHY_STYLE_INDEX[language],
      ),
    });
  }
  if (step === READER_STEP) {
    return JSON.stringify({
      misreadings: example.misreadings,
      discussionQuestions: example.discussionQuestions,
      // Вне `ru` ответ «Почему роман так называется» объясняет игру слов русского названия -
      // внешний факт без источника (А1): шагу 4 источников нет.
      faq: list(example.faq).filter((_, i) => language === 'ru' || i !== FOREIGN_FACT_FAQ_INDEX),
    });
  }
  if (step === EXTERNAL_STEP) return externalSample(example);
  return JSON.stringify({
    mainIdea: example.mainIdea,
    themes:
      language === 'ru'
        ? example.themes
        : list(example.themes).filter((th) => !FOREIGN_FACT_THEMES.has(trimmed(rec(th).key))),
    symbols: example.symbols,
    ...(language === 'ru' ? { titleMeaning: example.titleMeaning } : {}),
    endingMeaning: example.endingMeaning,
  });
}

const SAMPLE_REFS = [0];

/**
 * Эталон внешнего шага в форме **ответа**, а не импорта (`EXTERNAL_SHAPE`): абзацы и элементы со
 * ссылками `refs`, факты с `<факт>Refs`. Адреса источников эталона заменены на заглушку: реальные
 * адреса другой книги модель скопировала бы в свой ответ.
 */
function externalSample(example: (typeof EXAMPLE_ANALYSES)[Language]): string {
  const facts = rec(example.facts);
  const paragraphs = (text: unknown) =>
    trimmed(text)
      .split(/\n\s*\n/)
      .filter((p) => p.trim() !== '')
      .map((p) => ({ text: p.trim(), refs: SAMPLE_REFS }));
  const withRefs = (rows: unknown) => list(rows).map((row) => ({ ...rec(row), refs: SAMPLE_REFS }));
  return JSON.stringify({
    ...Object.fromEntries(
      EXTERNAL_FACTS.flatMap((f) => [
        [f, trimmed(facts[f])],
        [`${f}Refs`, trimmed(facts[f]) === '' ? [] : SAMPLE_REFS],
      ]),
    ),
    context: paragraphs(example.context),
    timeline: withRefs(example.timeline),
    reception: paragraphs(example.reception),
    adaptations: withRefs(example.adaptations),
    sources: list(example.sources).map((src, i) => ({
      title: trimmed(rec(src).title),
      url: `https://encyclopedia.example/article-${i + 1}`,
    })),
  });
}

/** Вход шага: запрос автору, запрос проверяющей, проверки, разбор ответа. */
export interface StepInput {
  step: AnalysisStepNumber;
  book: StepBook;
  author: (redo: StepRedo | null) => ShapedRequest;
  review: (draft: StepDraft) => ShapedRequest;
  read: (value: unknown) => StepDraft;
  codeCheck: (draft: StepDraft) => ReturnType<typeof stepRemarks>;
}

export function stepInput(
  step: AnalysisStepNumber,
  context: StepContext,
  book: StepBook,
  quotes: ChapterIndex,
  regen: StepRegen | null = null,
): StepInput {
  const glossary = glossaryText(context);
  const names = glossaryNames(context.glossary);
  const previous = previousOf(step, context);
  const targets: LinkTargets = {
    characterKeys: new Set(castOf(context).map((c) => c.key)),
    quoteIds: new Set(quotesOf(context).map((q) => q.id)),
    storedThemeKeys: new Set((context.stored.themes ?? []).map((th) => th.key)),
  };
  return {
    step,
    book,
    author: (redo) =>
      stepWriteRequest({
        step,
        language: context.language,
        bookTitle: context.bookTitle,
        author: context.author,
        chapterList: context.chapters.map((c) => `${c.number} — ${c.title}`).join('\n') || 'none',
        glossary,
        dossier: dossierText(context.dossier),
        keys: keysText(context),
        book: book.text,
        bookIsSummaries: book.isSummaries,
        previous,
        example: exampleSlice(step, context.language),
        redo,
        regen,
        originalLanguage: context.originalLanguage ?? '',
      }),
    review: (draft) =>
      stepReviewRequest({
        step,
        language: context.language,
        book: book.text,
        glossary,
        // Перегенерация: прежний вид самого блока - не «итог прошлых шагов», иначе проверяющая
        // сверила бы новый блок со старым (`CONTRADICTION`) и позвала платную переделку.
        previous: JSON.stringify(
          regen ? withoutTarget(context.merged, regen.target) : context.merged,
        ),
        answer: draft,
      }),
    read: (value) => {
      const draft = readStepAnswer(step, value, quotes, targets);
      return regen ? onlyTarget(draft, regen.target) : draft;
    },
    codeCheck: (draft) =>
      stepRemarks({
        language: context.language,
        stored: context.stored,
        merged: context.merged,
        draft,
        glossary: names,
      }),
  };
}

/** Спецификация цикла качества шага на моделях снимка операции. */
export function stepLoopSpec(
  input: StepInput,
  models: { author: StageModels; review: StageModels },
): QualityLoopSpec<StepDraft> {
  return {
    authorStage: STEP_STAGES[input.step],
    authorShape: STEP_SHAPES[input.step],
    authorModels: models.author,
    authorRequest: (redo) => input.author(redo),
    readAuthor: input.read,
    codeCheck: input.codeCheck,
    reviewStage: ANALYSIS_REVIEW_STAGE,
    reviewCodes: ANALYSIS_REVIEW_CODES,
    reviewModels: models.review,
    reviewRequest: input.review,
  };
}

/** Оценщики этапов хода: три автора и проверяющая. */
export interface AnalysisEstimators {
  cast: StageCallEstimator;
  quotes: StageCallEstimator;
  meaning: StageCallEstimator;
  reader: StageCallEstimator;
  external: StageCallEstimator;
  review: StageCallEstimator;
}

/** Оценщик автора шага: у оценки хода и у оценки перегенерации блока - один. */
export const stepAuthors = (
  calls: AnalysisEstimators,
): Record<AnalysisStepNumber, StageCallEstimator> => ({
  1: calls.cast,
  2: calls.quotes,
  3: calls.meaning,
  4: calls.reader,
  5: calls.external,
});

/** Проходов автора и проверки на шаг: первый и одна переделка (U5). */
const PASSES = 2;

/** Цена одного шага сверху: автор и проверяющая, каждый `PASSES` прохода (`tech.md` §6). */
export function stepUsd(
  author: StageCallEstimator,
  review: StageCallEstimator,
  input: StepInput,
  extraInputTokens: number,
): Prisma.Decimal {
  return author
    .estimate(input.author(null), extraInputTokens)
    .add(review.estimate(input.review(EMPTY_DRAFT), extraInputTokens + author.maxTokens))
    .mul(PASSES);
}

/**
 * Оценка шагов 1-5 сверху (`tech.md` §6): каждый шаг читает весь текст версии, плюс проверка
 * каждого шага, каждый шаг × 2 прохода автора и проверки. Итог прошлых шагов, которого ещё нет, -
 * сверху выходом их этапов; `extraInputTokens` - сверху на досье и глоссарий, которых ещё нет.
 * Одна функция на оценку ручного старта и будущую оценку запуска (`F07-3`).
 */
export function analysisPipelineUsd(
  calls: AnalysisEstimators,
  context: StepContext,
  extraInputTokens: number,
): Prisma.Decimal {
  const authors = stepAuthors(calls);
  let usd = new Prisma.Decimal(0);
  let previousOut = 0;
  for (const step of [1, 2, 3, 4, 5] as const) {
    const input = stepInput(step, context, bookFor(step, context), new Map());
    const author = authors[step];
    const extra = extraInputTokens + previousOut;
    usd = usd.add(stepUsd(author, calls.review, input, extra));
    previousOut += author.maxTokens;
  }
  return usd;
}
