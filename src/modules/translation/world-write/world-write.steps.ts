import { Language, Prisma } from '@prisma/client';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import type { StoredWorldEntity } from '../../book-world/book-world-data';
import { ANSWER_CHARS_PER_TOKEN, estimateInputTokens } from '../../llm/openrouter.client';
import type { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { chaptersText } from '../content-draft/content-draft.text';
import { ShapedRequest } from '../dossier/dossier.prompts';
import {
  dossierOf,
  glossaryNames,
  glossaryText,
  PartContext,
} from '../draft-quality/draft-context';
import { QualityLoopSpec } from '../draft-quality/quality-loop';
import { ChapterIndex } from '../draft-quality/quote-check';
import { DraftRemark } from '../draft-quality/text-checks';
import { StageModels } from '../run/run-models';
import {
  EMPTY_EXTERNAL,
  EMPTY_PAGE,
  EMPTY_SELECT,
  externalRemarks,
  foldedVersion,
  pageRemarks,
  readExternalAnswer,
  readPageAnswer,
  readSelectAnswer,
  WorldExternalDraft,
  WorldPageDraft,
  WorldSelectDraft,
} from './world-write.checks';
import { isWorldWriteLanguage, WORLD_REVIEW_STAGE } from './world-write.constants';
import { WorldCandidate, WorldStepKind, WorldStepSource } from './world-write.data';
import { EXAMPLE_WORLDS } from './examples';
import {
  externalWriteRequest,
  pageWriteRequest,
  selectWriteRequest,
  WORLD_REVIEW_CODES,
  WORLD_STEP_SHAPES,
  WORLD_STEP_STAGES,
  worldReviewRequest,
  WorldRedo,
  WorldRegenSpec,
} from './world-write.prompts';

/** Всё, из чего строятся шаги хода мира: общее у обработчика и оценки. */
export interface WorldContext extends PartContext {
  bookTitle: string;
  author: string;
  originalLanguage: string;
  chapters: ReadonlyArray<{ number: number; title: string; content: string }>;
  analysis: StoredBookAnalysis;
  /** Сущности мира версии по ключу (сохранённые). */
  entities: ReadonlyMap<string, StoredWorldEntity>;
  /** Названия книги и имена авторов всех её версий - подтверждение страницы источника. */
  names: { titles: string[]; authors: string[] };
}

/** Герой анализа версии - кандидат хода: роль нужна, чтобы отсеять второстепенных по порогу глав. */
export interface WorldBaseCharacter {
  key: string;
  name: string;
  role: 'main' | 'secondary';
}

/** Герои `main` анализа версии: без них ход не стартует (решение арбитра `F08 | F08-4`, Q3, Q4). */
export function mainCharacters(analysis: StoredBookAnalysis): WorldBaseCharacter[] {
  return (analysis.characters ?? [])
    .filter((c) => c.role === 'main')
    .map((c) => ({ key: c.key, name: c.name, role: 'main' as const }));
}

/**
 * Кандидаты хода (`F08-8b`): герои `main`, затем `secondary` анализа. Второстепенный остаётся
 * в ходе, только если стоит не меньше чем в `WORLD_MIN_CHAPTERS` главах (отсев - `candidatesOf`
 * обработчика после подсчёта присутствия); `minor` в ход не попадает.
 */
export function worldCharacters(analysis: StoredBookAnalysis): WorldBaseCharacter[] {
  const secondary = (analysis.characters ?? [])
    .filter((c) => c.role === 'secondary')
    .map((c) => ({ key: c.key, name: c.name, role: 'secondary' as const }));
  return [...mainCharacters(analysis), ...secondary];
}

/** Вход шага: запрос автора, запрос проверяющей, разбор ответа и проверки кода. */
export interface WorldStepInput<T> {
  kind: WorldStepKind;
  source: WorldStepSource;
  author: (redo: WorldRedo | null) => ShapedRequest;
  review: (draft: T) => ShapedRequest;
  read: (value: unknown) => T;
  codeCheck: (draft: T) => DraftRemark[];
  /** Пустой ответ - запрос проверяющей до ответа (оценка, проверка входа). */
  empty: T;
}

const NONE = 'none';

function analysisText(analysis: StoredBookAnalysis): string {
  return JSON.stringify({
    mainIdea: analysis.mainIdea,
    characters: (analysis.characters ?? []).map((c) => ({
      key: c.key,
      name: c.name,
      role: c.role,
      description: c.description,
    })),
    themes: (analysis.themes ?? []).map((t) => t.title),
  });
}

/** Ключи для ссылок страницы: герои анализа и сущности мира версии. */
export function refKeys(context: WorldContext): Set<string> {
  return new Set([
    ...(context.analysis.characters ?? []).map((c) => c.key),
    ...context.entities.keys(),
  ]);
}

function keysText(context: WorldContext): string {
  const lines = [
    ...(context.analysis.characters ?? []).map((c) => `${c.key} - ${c.name}`),
    ...[...context.entities.values()]
      .filter((e) => !(context.analysis.characters ?? []).some((c) => c.key === e.key))
      .map((e) => `${e.key} - ${e.name ?? ''}`),
  ];
  return lines.length > 0 ? lines.join('\n') : NONE;
}

const chapterList = (context: WorldContext): string =>
  context.chapters.map((c) => `${c.number} — ${c.title}`).join('\n') || NONE;

function dossierNames(dossier: unknown): string {
  const characters = dossierOf(dossier).characters ?? [];
  const lines = characters.flatMap((c) => {
    if (typeof c.name !== 'string') return [];
    const variants = Array.isArray(c.variants)
      ? c.variants.filter((v): v is string => typeof v === 'string')
      : [];
    return [`${c.name}${variants.length > 0 ? ` - ${variants.join(', ')}` : ''}`];
  });
  return lines.length > 0 ? lines.join('\n') : NONE;
}

/** Пример страницы для промпта: эталон языка версии (только `ru`/`en`, Q5). */
/** Эталон языка версии; языка вне хода нет - старт и оценка ему отказывают (Q5), эталона нет. */
const exampleOf = (language: Language): string =>
  isWorldWriteLanguage(language) ? JSON.stringify(EXAMPLE_WORLDS[language]) : NONE;

/** Книга шага: текст глав и признак «не всё». */
export interface WorldBook {
  text: string;
  partial: boolean;
}

export function selectInput(
  context: WorldContext,
  candidates: ReadonlyArray<{ key: string; name: string }>,
  quotes: ChapterIndex,
  book: WorldBook,
): WorldStepInput<WorldSelectDraft> {
  const folded = foldedVersion(quotes);
  const analysis = analysisText(context.analysis);
  return {
    kind: 'select',
    source: book.partial ? 'top' : 'text',
    author: (redo) =>
      selectWriteRequest({
        language: context.language,
        bookTitle: context.bookTitle,
        author: context.author,
        candidates: candidates.map((c) => `${c.key} - ${c.name}`).join('\n'),
        dossierNames: dossierNames(context.dossier),
        glossary: glossaryText(context),
        book: book.text,
        redo,
      }),
    review: (draft) =>
      worldReviewRequest({
        kind: 'select',
        language: context.language,
        book: book.text,
        analysis,
        answer: draft.characters,
        regenBlock: null,
      }),
    read: (value) => readSelectAnswer(value, candidates, folded),
    codeCheck: () => [],
    empty: EMPTY_SELECT,
  };
}

/** Главы, где есть герой, по убыванию числа вхождений (при равенстве - по номеру). */
function chaptersByMentions(candidate: WorldCandidate): number[] {
  const count = (n: number) => candidate.mentions.perChapter[String(n)] ?? 0;
  return [...candidate.mentions.chapters].sort((a, b) => count(b) - count(a) || a - b);
}

/**
 * Книга страницы (`tech.md` §5): текст глав, где есть герой; не влезает - главы с наибольшим
 * числом упоминаний (`top` первых) по порядку глав и краткое содержание глав досье.
 */
export function pageBook(
  context: WorldContext,
  candidate: WorldCandidate,
  top: number | null,
): WorldBook {
  if (top === null) {
    const own = context.chapters.filter((c) => candidate.mentions.chapters.includes(c.number));
    return { text: chaptersText(own) || NONE, partial: false };
  }
  const chosen = new Set(chaptersByMentions(candidate).slice(0, top));
  const own = context.chapters.filter((c) => chosen.has(c.number));
  const summaries = (dossierOf(context.dossier).chapters ?? [])
    .map(
      (c) =>
        `[CHAPTER ${typeof c.number === 'number' ? c.number : '?'}] ` +
        `${typeof c.title === 'string' ? c.title : ''}\n${typeof c.summary === 'string' ? c.summary : ''}`,
    )
    .join('\n\n');
  return {
    text: [summaries, chaptersText(own)].filter((t) => t !== '').join('\n\n') || NONE,
    partial: true,
  };
}

export function pageInput(
  context: WorldContext,
  candidate: WorldCandidate,
  quotes: ChapterIndex,
  book: WorldBook,
  regen: WorldRegenSpec | null = null,
): WorldStepInput<WorldPageDraft> {
  const analysis = analysisText(context.analysis);
  const check = {
    key: candidate.key,
    language: context.language,
    chapters: quotes,
    mentionChapters: new Set(candidate.mentions.chapters),
    refKeys: refKeys(context),
    glossary: glossaryNames(context.glossary),
  };
  const onlyBlock = (draft: WorldPageDraft): WorldPageDraft =>
    regen
      ? {
          ...draft,
          blocks: Object.fromEntries(
            Object.entries(draft.blocks).filter(([block]) => block === regen.block),
          ),
        }
      : draft;
  return {
    kind: 'page',
    source: book.partial ? 'top' : 'text',
    author: (redo) =>
      pageWriteRequest({
        language: context.language,
        bookTitle: context.bookTitle,
        author: context.author,
        key: candidate.key,
        name: candidate.name,
        aliases: candidate.aliases.join('\n') || NONE,
        chapterList: chapterList(context),
        mentionChapters:
          candidate.mentions.chapters
            .map((n) => `${n} - ${candidate.mentions.perChapter[String(n)] ?? 0}`)
            .join('\n') || NONE,
        keys: keysText(context),
        analysis,
        glossary: glossaryText(context),
        example: exampleOf(context.language),
        book: book.text,
        bookIsPartial: book.partial,
        regen,
        redo,
      }),
    review: (draft) =>
      worldReviewRequest({
        kind: 'page',
        language: context.language,
        book: book.text,
        analysis,
        answer: { name: draft.name, ...draft.blocks },
        regenBlock: regen?.block ?? null,
      }),
    read: (value) => onlyBlock(readPageAnswer(value, check)),
    codeCheck: (draft) => pageRemarks(draft, check, candidate.name),
    empty: EMPTY_PAGE,
  };
}

export function externalInput(
  context: WorldContext,
  candidate: WorldCandidate,
  page: unknown,
  regen: WorldRegenSpec | null = null,
): WorldStepInput<WorldExternalDraft> {
  const analysis = analysisText(context.analysis);
  const glossary = glossaryNames(context.glossary);
  const onlyBlock = (draft: WorldExternalDraft): WorldExternalDraft =>
    regen
      ? {
          ...draft,
          blocks: Object.fromEntries(
            Object.entries(draft.blocks).filter(([block]) => block === regen.block),
          ),
        }
      : draft;
  return {
    kind: 'external',
    source: 'none',
    author: (redo) =>
      externalWriteRequest({
        language: context.language,
        bookTitle: context.bookTitle,
        author: context.author,
        originalLanguage: context.originalLanguage,
        name: candidate.name,
        page: JSON.stringify(page ?? null),
        regen,
        redo,
      }),
    review: (draft) =>
      worldReviewRequest({
        kind: 'external',
        language: context.language,
        book: NONE,
        analysis,
        answer: { ...draft.blocks, sources: draft.sources },
        regenBlock: regen?.block ?? null,
      }),
    read: (value) => onlyBlock(readExternalAnswer(value)),
    codeCheck: (draft) =>
      externalRemarks(draft, candidate.key, candidate.name, context.language, glossary),
    empty: EMPTY_EXTERNAL,
  };
}

/** Спецификация цикла качества шага на моделях снимка операции. */
export function worldLoopSpec<T>(
  input: WorldStepInput<T>,
  models: { author: StageModels; review: StageModels },
): QualityLoopSpec<T> {
  return {
    authorStage: WORLD_STEP_STAGES[input.kind],
    authorShape: WORLD_STEP_SHAPES[input.kind],
    authorModels: models.author,
    authorRequest: (redo) => input.author(redo as WorldRedo | null),
    readAuthor: input.read,
    codeCheck: input.codeCheck,
    reviewStage: WORLD_REVIEW_STAGE,
    reviewCodes: WORLD_REVIEW_CODES,
    reviewModels: models.review,
    reviewRequest: input.review,
  };
}

/**
 * Влезает ли вход шага: запрос автора - `stageFit` его этапа; запрос проверяющей - с пустым ответом
 * плюс `maxTokens` автора в символах против границы проверяющей (как `stepInputFits` анализа).
 */
export async function worldInputFits<T>(
  llm: Pick<LlmService, 'stageFit' | 'stageInputCeiling' | 'getStageSetting'>,
  input: WorldStepInput<T>,
): Promise<boolean> {
  const stage = WORLD_STEP_STAGES[input.kind];
  if (!(await llm.stageFit(stage, input.author(null))).fits) return false;
  const [{ maxInputChars }, author] = await Promise.all([
    llm.stageInputCeiling(WORLD_REVIEW_STAGE),
    llm.getStageSetting(stage),
  ]);
  if (maxInputChars === null) return true;
  return (
    estimateInputTokens(input.review(input.empty)) + author.maxTokens * ANSWER_CHARS_PER_TOKEN <=
    maxInputChars
  );
}

/**
 * Наибольшее `count` из `0..max`, при котором `make(count)` влезает (вход растёт с `count`), поиском
 * делением пополам; не влезает и `make(0)` - `null`.
 */
export async function largestFitting<T>(
  max: number,
  make: (count: number) => WorldStepInput<T>,
  fits: (input: WorldStepInput<T>) => Promise<boolean>,
): Promise<WorldStepInput<T> | null> {
  let best = make(0);
  if (!(await fits(best))) return null;
  let low = 0;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = make(middle);
    if (await fits(candidate)) {
      low = middle;
      best = candidate;
    } else high = middle - 1;
  }
  return best;
}

/** Оценщики этапов хода мира. */
export interface WorldEstimators {
  select: StageCallEstimator;
  page: StageCallEstimator;
  external: StageCallEstimator;
  review: StageCallEstimator;
}

/** Проходов автора и проверки на шаг: первый и одна переделка. */
const PASSES = 2;

export function worldStepUsd<T>(
  author: StageCallEstimator,
  review: StageCallEstimator,
  input: WorldStepInput<T>,
  extraInputTokens: number,
): Prisma.Decimal {
  return author
    .estimate(input.author(null), extraInputTokens)
    .add(review.estimate(input.review(input.empty), extraInputTokens + author.maxTokens))
    .mul(PASSES);
}

/**
 * Оценка хода сверху (`tech.md` §5): выбор героев по всему тексту версии, затем на каждого героя
 * `main` и `secondary` (до порога глав, решение арбитра `F08 | F08-8b` Q1) страница по всему
 * тексту версии (сверху: ход берёт только главы с героем) и внешние блоки, каждый шаг с проверяющей × 2 прохода. Итог страницы во входе внешнего шага - сверху выходом этапа.
 */
export function worldPipelineUsd(
  calls: WorldEstimators,
  context: WorldContext,
  extraInputTokens: number,
): Prisma.Decimal {
  const candidates = worldCharacters(context.analysis);
  const whole: WorldBook = { text: chaptersText(context.chapters) || NONE, partial: false };
  const quotes: ChapterIndex = new Map();
  let usd = worldStepUsd(
    calls.select,
    calls.review,
    selectInput(context, candidates, quotes, whole),
    extraInputTokens,
  );
  for (const c of candidates) {
    const candidate: WorldCandidate = {
      ...c,
      aliases: [],
      mentions: { chapters: [], perChapter: {} },
    };
    usd = usd
      .add(
        worldStepUsd(
          calls.page,
          calls.review,
          pageInput(context, candidate, quotes, whole),
          extraInputTokens,
        ),
      )
      .add(
        worldStepUsd(
          calls.external,
          calls.review,
          externalInput(context, candidate, null),
          extraInputTokens + calls.page.maxTokens,
        ),
      );
  }
  return usd;
}
