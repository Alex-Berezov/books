import { Language, Prisma } from '@prisma/client';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import type { StoredWorldEntity } from '../../book-world/book-world-data';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { characterKeyRefused, worldPairKey } from '../../book-world/world-refs';
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
  EMPTY_PAIR,
  EMPTY_SELECT,
  externalRemarks,
  foldedVersion,
  pageRemarks,
  pairRemarks,
  readExternalAnswer,
  readPageAnswer,
  readPairAnswer,
  readSelectAnswer,
  WorldExternalDraft,
  WorldPageDraft,
  WorldPairDraft,
  WorldSelectDraft,
} from './world-write.checks';
import { isWorldWriteLanguage, WORLD_PAIRS_MAX, WORLD_REVIEW_STAGE } from './world-write.constants';
import {
  WorldCandidate,
  WorldCandidateRole,
  WorldPairCandidate,
  WorldStepKind,
  WorldStepSource,
} from './world-write.data';
import { EXAMPLE_WORLD_PAIRS, EXAMPLE_WORLDS } from './examples';
import {
  externalWriteRequest,
  pageWriteRequest,
  pairWriteRequest,
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
  role: WorldCandidateRole;
}

/** Герои анализа ролей `main`, затем `secondary` - до отсева ключей вида пары. */
function allRunCharacters(analysis: StoredBookAnalysis): WorldBaseCharacter[] {
  const of = (role: WorldCandidateRole) =>
    (analysis.characters ?? [])
      .filter((c) => c.role === role)
      .map((c) => ({ key: c.key, name: c.name, role }));
  return [...of('main'), ...of('secondary')];
}

/**
 * Героя ход не берёт, если его запись отобьётся (`characterKeyRefused`, `F08-8e-1` Q7, `LEGACY-507`):
 * `stored` - ключи героев мира версии; заведённый герой с `--` правится и в ходе остаётся.
 */
const refusedPairForm = (key: string, stored: ReadonlySet<string>): boolean =>
  characterKeyRefused(key, stored.has(key) ? 'character' : null);

/**
 * Герои `main` анализа версии, которых ход может взять: без них ход не стартует (решение арбитра
 * `F08 | F08-4`, Q3, Q4); ключ вида пары нового героя не в счёт (`F08-8e-1` Q7: иначе платный ход без
 * кандидатов).
 */
export function mainCharacters(
  analysis: StoredBookAnalysis,
  stored: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): WorldBaseCharacter[] {
  return worldCharacters(analysis, stored, taken).filter((c) => c.role === 'main');
}

/**
 * Герои `main` и `secondary` анализа с ключом вида пары, которых нет героями в мире версии (`F08-8e-1`
 * Q7, `LEGACY-507`): запись такого героя отбивается, в ход он не идёт и виден отсеянным с `KEY_PAIR_FORM`.
 */
export function pairFormCharacters(
  analysis: StoredBookAnalysis,
  stored: ReadonlySet<string> = new Set(),
): WorldBaseCharacter[] {
  return allRunCharacters(analysis).filter((c) => refusedPairForm(c.key, stored));
}

/**
 * Кандидаты хода (`F08-8b`): герои `main`, затем `secondary` анализа. Второстепенный остаётся
 * в ходе, только если стоит не меньше чем в `WORLD_MIN_CHAPTERS` главах (отсев - `candidatesOf`
 * обработчика после подсчёта присутствия); `minor` в ход не попадает; ключ вида пары - тоже
 * (`pairFormCharacters`, решение арбитра `F08 | F08-8e-1` Q7: не платить за страницу под отказ записи).
 */
export function worldCharacters(
  analysis: StoredBookAnalysis,
  stored: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): WorldBaseCharacter[] {
  return allRunCharacters(analysis).filter(
    (c) => !refusedPairForm(c.key, stored) && !taken.has(c.key),
  );
}

/**
 * Ключи мира версии, занятые сущностью другого типа (пара, место — `F08-12a`): героя на таком ключе
 * ход не пишет — запись слила бы страницу героя с полями места и получила 400 после платного шага
 * (`checkWorldTypeFields`), или молча превратила бы место в героя.
 */
export const keysOfOtherTypes = (
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
): Set<string> =>
  new Set([...entities].flatMap(([key, e]) => (e.type !== 'character' ? [key] : [])));

/** Ключи героев (`character`) мира версии - заведённые герои с `--` остаются в ходе (Q7). */
export const storedCharacterKeys = (
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
): Set<string> =>
  new Set([...entities].flatMap(([key, e]) => (e.type === 'character' ? [key] : [])));

/** Анализ и сохранённые сущности версии на ключах его героев — вход отбора кандидатов хода. */
export interface WorldRunSource {
  analysis: StoredBookAnalysis;
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>;
}

/**
 * Кандидаты хода по сохранённому миру версии (`entities`) — одна сборка на шаг выбора, проверку
 * старта шага 0, старт и оценку хода (`WorldWriteService`): заведённые герои с ключом вида пары остаются (Q7), ключи пары и места
 * в ход не идут (`keysOfOtherTypes`, `F08-12a`).
 */
export const runCharacters = (context: WorldRunSource): WorldBaseCharacter[] =>
  worldCharacters(
    context.analysis,
    storedCharacterKeys(context.entities),
    keysOfOtherTypes(context.entities),
  );

/** Герои `main` среди `runCharacters`: без них ход не стартует (Q4) и шаг 0 не идёт. */
export const runMainCharacters = (context: WorldRunSource): WorldBaseCharacter[] =>
  mainCharacters(
    context.analysis,
    storedCharacterKeys(context.entities),
    keysOfOtherTypes(context.entities),
  );

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

/** Эталон языка версии; языка вне хода нет - старт и оценка ему отказывают (Q5), эталона нет. */
const exampleOf = (language: Language): string =>
  isWorldWriteLanguage(language) ? JSON.stringify(EXAMPLE_WORLDS[language]) : NONE;

/** Эталон пары языка версии; языка без эталона пары у этапа пар нет (Q6), эталона - тоже. */
const pairExampleOf = (language: Language): string => {
  const example = isWorldWriteLanguage(language) ? EXAMPLE_WORLD_PAIRS[language] : undefined;
  return example ? JSON.stringify(example) : NONE;
};

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

/** Герои пары из кандидатов хода: главы и имя каждого (имя - выбора героев или анализа). */
export interface WorldPairMembers {
  a: WorldCandidate;
  b: WorldCandidate;
}

/**
 * Главы текста шага пары (`F08-8e`): общие главы героев; у пары без общих глав - главы обоих героев
 * (иначе сравнивать не по чему). По порядку глав. Подмена - у любой пары: перегенерации, оплаченному
 * шагу и оценке перегенерации нужен текст (Q1-бис `F08 | F08-8e-4`); новый шаг несвязанной пары без
 * общих глав до вызова не доходит - его закрывает `pairRefusal` (Q1).
 */
export function pairChapters(pair: WorldPairCandidate, members: WorldPairMembers): number[] {
  if (pair.chapters.length > 0) return [...pair.chapters].sort((x, y) => x - y);
  return [...new Set([...members.a.mentions.chapters, ...members.b.mentions.chapters])].sort(
    (x, y) => x - y,
  );
}

/** Книга шага пары и номера глав, чей текст в ней есть. */
export interface WorldPairBook extends WorldBook {
  chapters: number[];
}

/** Книга пары: текст первых `count` глав пары (`null` - всех). */
export function pairBook(
  context: WorldContext,
  chapters: readonly number[],
  count: number | null,
): WorldPairBook {
  const chosen = count === null ? [...chapters] : chapters.slice(0, count);
  const own = context.chapters.filter((c) => chosen.includes(c.number));
  return {
    text: chaptersText(own) || NONE,
    partial: count !== null && count < chapters.length,
    chapters: chosen,
  };
}

/** Союз «и» языка версии - запасное имя пары («{Имя} и {Имя}», `prompts/world-pair.md` §name). */
const PAIR_AND: Record<Language, string> = { ru: 'и', en: 'and', es: 'y', fr: 'et', pt: 'e' };

/**
 * Имя пары, если модель его не дала: имена героев через союз языка, как в эталоне; длиннее предела
 * имени импорта - ключи героев через союз (иначе запись отбила бы оплаченную страницу).
 */
export function pairFallbackName(language: Language, members: WorldPairMembers): string {
  const name = `${members.a.name} ${PAIR_AND[language]} ${members.b.name}`;
  return name.length <= BOOK_WORLD_LIMITS.name
    ? name
    : `${members.a.key} ${PAIR_AND[language]} ${members.b.key}`;
}

const chaptersLine = (chapters: readonly number[]): string =>
  chapters.length > 0 ? chapters.join(', ') : NONE;

export function pairInput(
  context: WorldContext,
  pair: WorldPairCandidate,
  members: WorldPairMembers,
  quotes: ChapterIndex,
  book: WorldPairBook,
  regen: WorldRegenSpec | null = null,
): WorldStepInput<WorldPairDraft> {
  const analysis = analysisText(context.analysis);
  // Сторона строки сравнения - только в главе своего героя, чей текст модель и проверяющая видели.
  const given = new Set(book.chapters);
  const chaptersA = members.a.mentions.chapters.filter((n) => given.has(n));
  const chaptersB = members.b.mentions.chapters.filter((n) => given.has(n));
  const check = {
    key: pair.key,
    a: pair.a,
    b: pair.b,
    language: context.language,
    chapters: quotes,
    chaptersA: new Set(chaptersA),
    chaptersB: new Set(chaptersB),
    glossary: glossaryNames(context.glossary),
    // Перегенерация одного блока: ядра всей пары в таком ответе нет - не проверяется.
    core: regen === null,
  };
  const name = pairFallbackName(context.language, members);
  const onlyBlock = (draft: WorldPairDraft): WorldPairDraft =>
    regen
      ? {
          ...draft,
          blocks: Object.fromEntries(
            Object.entries(draft.blocks).filter(([block]) => block === regen.block),
          ),
        }
      : draft;
  return {
    kind: 'pair',
    source: book.partial ? 'top' : 'text',
    author: (redo) =>
      pairWriteRequest({
        language: context.language,
        bookTitle: context.bookTitle,
        author: context.author,
        key: pair.key,
        first: `${members.a.key} - ${members.a.name}`,
        second: `${members.b.key} - ${members.b.name}`,
        chapterList: chapterList(context),
        chaptersA: chaptersLine(chaptersA),
        chaptersB: chaptersLine(chaptersB),
        analysis,
        glossary: glossaryText(context),
        example: pairExampleOf(context.language),
        book: book.text,
        bookIsPartial: book.partial,
        regen,
        redo,
      }),
    review: (draft) =>
      worldReviewRequest({
        kind: 'pair',
        language: context.language,
        book: book.text,
        analysis,
        answer: { name: draft.name, ...draft.blocks },
        regenBlock: regen?.block ?? null,
      }),
    read: (value) => onlyBlock(readPairAnswer(value, check)),
    codeCheck: (draft) => pairRemarks(draft, check, name),
    empty: EMPTY_PAIR,
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
  pair: StageCallEstimator;
  review: StageCallEstimator;
}

/**
 * Шагов пар сверху (решение арбитра `F08 | F08-8e-1` Q8): `min(WORLD_PAIRS_MAX, C(N,2))` по героям
 * хода; на языке без эталона пары - 0 (Q6). Присутствие до старта неизвестно - граница сверху.
 */
export function pairStepsUpperBound(heroes: number, pairsOn: boolean): number {
  return pairsOn && heroes >= 2 ? Math.min(WORLD_PAIRS_MAX, (heroes * (heroes - 1)) / 2) : 0;
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
 * тексту версии (сверху: ход берёт только главы с героем) и внешние блоки, затем `pairs` шагов пар
 * по всему тексту версии (`F08-8e-1` Q8), каждый шаг с проверяющей × 2 прохода. Итог страницы во
 * входе внешнего шага - сверху выходом этапа.
 */
export function worldPipelineUsd(
  calls: WorldEstimators,
  context: WorldContext,
  extraInputTokens: number,
  pairs = 0,
  run: WorldRunSource = context,
): Prisma.Decimal {
  // Кандидаты — тем же правилом, что у выбора шага и старта (`runCharacters`); `run` — анализ и
  // сущности на ключах его героев, когда в контексте оценки сохранённого мира нет (старт хода).
  const candidates = runCharacters(run);
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
  if (pairs > 0 && candidates.length >= 2) {
    const [a, b] = candidates.map(
      (c): WorldCandidate => ({ ...c, aliases: [], mentions: { chapters: [], perChapter: {} } }),
    );
    const pair: WorldPairCandidate = {
      key: worldPairKey(a.key, b.key) ?? a.key,
      a: a.key,
      b: b.key,
      linked: true,
      chapters: [],
    };
    const step = worldStepUsd(
      calls.pair,
      calls.review,
      pairInput(context, pair, { a, b }, quotes, {
        ...whole,
        chapters: context.chapters.map((c) => c.number),
      }),
      extraInputTokens,
    );
    usd = usd.add(step.mul(pairs));
  }
  return usd;
}
