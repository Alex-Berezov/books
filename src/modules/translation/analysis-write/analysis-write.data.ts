import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { FillableFact } from '../content-draft/content-draft.analysis';
import { DRAFT_DATA_INVALID } from '../content-draft/content-draft.constants';
import { ANALYSIS_STEPS, LEGACY_ANALYSIS_STEPS } from './analysis-write.constants';
import { QualityLoopResume, ReviewState } from '../draft-quality/quality-loop';
import { QUOTE_CHECK_REASONS, QuoteCheckReason } from '../draft-quality/quote-check';
import { DRAFT_REMARK_CODES, DraftRemark, DraftRemarkCode } from '../draft-quality/text-checks';

/**
 * Данные хода анализа в `ContentDraft.data` (`features/F07-analysis-autofill/tech.md` §5):
 * `{ steps, items, merged, themeLinks, droppedQuotes, owns, written, pending }`. Форма
 * проверяется на чтении, как у хода пересказа (`readWriteData`): элемент не той формы остаётся на
 * своём месте заглушкой «не удалось» и пишется назад как был.
 */

/** Единица записи и предложения: блок анализа или подполе `facts.<имя>` (`tech.md` §5). */
export const ANALYSIS_TARGETS = [
  'facts.settingPlace',
  'facts.settingTime',
  'facts.narrator',
  'facts.structure',
  'characters',
  'keyQuotes',
  'style',
  'mainIdea',
  'themes',
  'symbols',
  'titleMeaning',
  'endingMeaning',
  'misreadings',
  'discussionQuestions',
  'faq',
  'facts.genre',
  'facts.movement',
  'facts.writtenYears',
  'context',
  'timeline',
  'reception',
  'adaptations',
  'sources',
] as const;
export type AnalysisTarget = (typeof ANALYSIS_TARGETS)[number];

/** Подполя `facts`, которые пишет внешний шаг (`product.md` §2, шаг 5); флаг `EXTERNAL_CHECK` - только у них. */
export const EXTERNAL_FACTS = ['genre', 'movement', 'writtenYears'] as const;
export type ExternalFact = (typeof EXTERNAL_FACTS)[number];

/** Подполе `facts` единицы записи `facts.<подполе>`; блок целиком - `null`. */
export const factField = (target: AnalysisTarget): FillableFact | ExternalFact | null =>
  target.startsWith('facts.')
    ? (target.slice('facts.'.length) as FillableFact | ExternalFact)
    : null;

/** Блок анализа единицы записи: `facts.<подполе>` - блок `facts`. */
export const blockOfTarget = (target: AnalysisTarget): string =>
  target.startsWith('facts.') ? 'facts' : target;

/**
 * Путь поля (`keyQuotes.2`, `facts.settingTime`, `characters[key=anna]`) лежит в единице записи:
 * совпадает с ней или продолжает её через границу сегмента - `facts.setting` не держит
 * `facts.settingTime`.
 */
export function pathInTarget(path: string, target: AnalysisTarget): boolean {
  // Путь блока `facts` целиком относится и к каждому его подполю.
  if (factField(target) !== null && path === 'facts') return true;
  return path === target || ['.', '[', ':'].some((edge) => path.startsWith(`${target}${edge}`));
}

export type AnalysisStepNumber = 1 | 2 | 3 | 4 | 5;

/** Блоки, которые пишет шаг (`product.md` §2); `themeKeys` шага 3 - отдельными элементами. */
export const STEP_TARGETS: Record<AnalysisStepNumber, readonly AnalysisTarget[]> = {
  1: ['facts.settingPlace', 'facts.settingTime', 'facts.narrator', 'facts.structure', 'characters'],
  2: ['keyQuotes', 'style'],
  3: ['mainIdea', 'themes', 'symbols', 'titleMeaning', 'endingMeaning'],
  4: ['misreadings', 'discussionQuestions', 'faq'],
  5: [
    'facts.genre',
    'facts.movement',
    'facts.writtenYears',
    'context',
    'timeline',
    'reception',
    'adaptations',
    'sources',
  ],
};

/** Блоки анализа, которые пишут шаги 1-3. Ключа нет - блок шаг не дал (`[]` и `''` не бывает, Л4). */
export type StepBlocks = Partial<{
  [K in
    | 'facts'
    | 'characters'
    | 'keyQuotes'
    | 'style'
    | 'mainIdea'
    | 'themes'
    | 'symbols'
    | 'titleMeaning'
    | 'endingMeaning'
    | 'misreadings'
    | 'discussionQuestions'
    | 'faq'
    | 'context'
    | 'timeline'
    | 'reception'
    | 'adaptations'
    | 'sources']: NonNullable<StoredBookAnalysis[K]>;
}>;

/**
 * Связи тем шага 3 (`tech.md` §2): ключ героя → ключи тем; отпечаток цитаты (`quotePrint`) → ключи
 * тем. Тексты шагов 1-2 шаг 3 не меняет: связи вливаются кодом.
 */
export interface ThemeLinks {
  characters: Record<string, string[]>;
  keyQuotes: Record<string, string[]>;
}

/** Выброшенная цитата: не нашлась дословно в главе (`QUOTE_NOT_VERBATIM`, `product.md` §3.2). */
export interface DroppedQuote {
  step: AnalysisStepNumber;
  path: string;
  text: string;
  chapter: number | null;
  reason: QuoteCheckReason;
}

/**
 * Правка кода без переделки (решение арбитра `F07 | F07-1`, В3): номер главы снят
 * (`CHAPTER_UNKNOWN`), хвост сверх предела импорта отрезан (`LIMIT_OUT`), связь темы на неизвестный
 * элемент выброшена (`IMPORT_INVALID`).
 */
export const STEP_FIX_CODES = [
  'CHAPTER_UNKNOWN',
  'LIMIT_OUT',
  'IMPORT_INVALID',
  'SOURCE_UNREACHABLE',
  'SOURCE_UNRELATED',
  'SOURCE_UNVERIFIED',
  'EXTERNAL_DOUBT',
] as const satisfies readonly DraftRemarkCode[];
export type StepFixCode = (typeof STEP_FIX_CODES)[number];

export interface StepFix {
  code: StepFixCode;
  path: string;
  note: string;
}

/**
 * Ссылки внешних утверждений шага 5 на `sources` (`tech.md` §4, `sourceRefs`): индексы источников
 * ответа по порядку утверждений - абзацы `context` и `reception`, события `timeline`, экранизации
 * `adaptations`; у фактов - по имени. Служебные, в импорт не уходят.
 */
export interface SourceRefs {
  facts: Partial<Record<ExternalFact, number[]>>;
  context: number[][];
  reception: number[][];
  timeline: number[][];
  adaptations: number[][];
}

/** Источник, отброшенный проверкой кода (`product.md` §3.3). */
export interface DroppedSource {
  title: string;
  /** Только хост: полный адрес с параметрами в данные и журнал не идёт. */
  host: string;
  reason: 'SOURCE_UNREACHABLE' | 'SOURCE_UNRELATED';
}

/** Ответ шага после правок кода - то, что видят код-проверки, проверяющая и запись. */
export interface StepDraft {
  blocks: StepBlocks;
  /** Только у шага 3. */
  themeLinks: ThemeLinks | null;
  /** Только у шага 5; нет поля - как `null`. */
  refs?: SourceRefs | null;
  droppedQuotes: Array<Omit<DroppedQuote, 'step'>>;
  fixes: StepFix[];
}

/** Вердикт шага и блока хода анализа: `ok` - без замечаний, `flags` - есть флаги, `failed` - нет текста. */
export const ANALYSIS_VERDICTS = ['ok', 'flags', 'failed'] as const;
export type AnalysisVerdict = (typeof ANALYSIS_VERDICTS)[number];

/** Как прошла проверяющая (`ReviewState` цикла качества): `answered` или почему её не было. */
export const ANALYSIS_REVIEW_KINDS = [
  'answered',
  'not_independent',
  'too_long',
  'invalid',
  'no_provider',
  'unavailable',
] as const satisfies ReadonlyArray<ReviewState['kind']>;

/** Пустой ответ шага - запрос проверяющей до ответа (оценка, проверка входа). */
export const EMPTY_DRAFT: StepDraft = {
  blocks: {},
  themeLinks: null,
  refs: null,
  droppedQuotes: [],
  fixes: [],
};

export const STEP_OUTCOMES = ['done', 'failed'] as const;

/**
 * Откуда шаг брал книгу: весь текст версии, краткое содержание глав досье (`tech.md` §2) или ниоткуда
 * (шаг 5 - внешний, текста книги не читает).
 */
export const STEP_SOURCES = ['text', 'summaries', 'none'] as const;
export type StepSource = (typeof STEP_SOURCES)[number];

export interface AnalysisStep {
  step: AnalysisStepNumber;
  verdict: AnalysisVerdict;
  remarks: DraftRemark[];
  attempt: 1 | 2;
  outcome: (typeof STEP_OUTCOMES)[number];
  failedReason: string | null;
  authorModel: string | null;
  review: ReviewState | null;
  source: StepSource | null;
  dropped: StepFix[];
}

/**
 * Судьба блока хода: `waiting` - итог шага сохранён, запись ещё не решена (обрыв между записями
 * дописывает её следующим шагом); `written` - в анализе; `proposed` - предложение редактору;
 * `accepted`/`discarded` - решение редактора (`F07-1b`); `none` - не записан и не предложен
 * (`failedReason`).
 */
export const ANALYSIS_ITEM_OUTCOMES = [
  'waiting',
  'written',
  'proposed',
  'accepted',
  'discarded',
  'none',
] as const;
export type AnalysisItemOutcome = (typeof ANALYSIS_ITEM_OUTCOMES)[number];

export interface AnalysisItem {
  target: AnalysisTarget;
  step: AnalysisStepNumber;
  verdict: AnalysisVerdict;
  remarks: DraftRemark[];
  /** Как прошла проверяющая (решение арбитра `F06 | F06-1`, В5). */
  review: ReviewState | null;
  outcome: AnalysisItemOutcome;
  /** Отпечаток блока на момент предложения: «Accept» сверяет содержимое (`tech.md` §5). */
  hash: string | null;
  /** Содержимое блока (подполя), которое ход пишет или предлагает; `null` - ещё не собрано. */
  value: unknown;
  failedReason: string | null;
  /** `themeKeys` шага 3 в блоке шагов 1-2 (`characters`, `keyQuotes`), а не текст шага. */
  links: boolean;
  /** Идёт перегенерация блока своей операцией (`F07-1b`); `null` - нет. */
  regen: AnalysisRegen | null;
  /** Почему последняя перегенерация не дала текста; `null` - не было или удалась. */
  regenFailedReason: string | null;
  /**
   * Выброшенные цитаты итога перегенерации, пока он не в анализе: итог входит в `merged` и
   * `droppedQuotes` хода только записью или «Accept» (`withRegenTaken`); отброшенный - не входит.
   * Нет (`null`/нет поля) - блок не из перегенерации или итог уже взят.
   */
  pendingDropped?: DroppedQuote[] | null;
  /**
   * Связи тем ответа перегенерации тем (`F07-2b`): в `themeLinks` хода - только записью или «Accept»
   * (решение арбитра `F07 | F07-2b`, п.3); нет - блок не тем или итог уже взят.
   */
  pendingLinks?: ThemeLinks | null;
  /**
   * Проверенные источники перегенерации блока шага 5 (`F07-2b`): пишутся той же записью, что блок,
   * объединением с сохранёнными по адресу (решение арбитра `F07 | F07-2b`, п.1).
   */
  pendingSources?: AnalysisSource[] | null;
  /** Элемент не той формы - сохранён как был, место в `items` не сдвигается. */
  broken?: unknown;
}

/**
 * Перегенерация блока хода `ready` (`F07-1b`, образец `WriteItem.regen` пересказа): своя операция,
 * замечание редактора в промпт автора, оплаченный текст до итога (`pending`, как у шага хода).
 */
export interface AnalysisRegen {
  operationId: string;
  remark: string | null;
  pending: PendingStep | null;
  /**
   * Блок до итога перегенерации: итог ждёт решения (`waiting`), а отмена или сбой между записью
   * итога и решением возвращают блок как был, а не оставляют его ждущим навсегда.
   */
  previous: AnalysisItem | null;
}

/** Оплаченный текст шага до итога (как `PendingText` хода пересказа, решение `F06 | F06-2`, Р3). */
export interface PendingStep {
  key: string;
  operationId: string;
  resume: QualityLoopResume<StepDraft>;
}

export interface AnalysisWriteData {
  steps: AnalysisStep[];
  items: AnalysisItem[];
  /** Итоги шагов хода поверх друг друга - вход следующих шагов и проверка ссылок. */
  merged: StepBlocks;
  themeLinks: ThemeLinks | null;
  droppedQuotes: DroppedQuote[];
  /** Источники, не прошедшие проверку кода (шаг 5). */
  droppedSources: DroppedSource[];
  /** Шагов в ходе: ходы `F07-1` - три, новые - пять (`F07-2a`). */
  stepsTotal: number;
  /** Право хода на блок - на старте (`tech.md` §5): версия не опубликована и блок пуст. */
  owns: Partial<Record<AnalysisTarget, boolean>>;
  /** Отпечаток блока после последней записи хода (на старте - блока на старте). */
  written: Partial<Record<AnalysisTarget, string>>;
  pending: PendingStep | null;
  /**
   * Запись шага не той формы или шаги не по порядку: номер следующего шага не вывести - ход
   * отказывает `DRAFT_DATA_INVALID`, а не повторяет оплаченный шаг. В данные не пишется.
   */
  stepsBroken: boolean;
}

export const emptyAnalysisData = (
  owns: AnalysisWriteData['owns'],
  written: AnalysisWriteData['written'],
): AnalysisWriteData => ({
  steps: [],
  items: [],
  merged: {},
  themeLinks: null,
  droppedQuotes: [],
  droppedSources: [],
  stepsTotal: ANALYSIS_STEPS,
  owns,
  written,
  pending: null,
  stepsBroken: false,
});

/**
 * Сериализация с ключами по алфавиту на каждом уровне: jsonb переставляет ключи объекта (Л2),
 * поэтому отпечаток не зависит от порядка ключей. `undefined` у ключа - как отсутствие ключа.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Отпечаток содержимого блока: sha256 стабильной сериализации (`tech.md` §5, Л2). */
export const blockPrint = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');

/** Отпечаток предложения: всё, что вносит его «Accept» - содержимое, источники, связи (`T174`, п.2). */
export const proposalPrint = (item: AnalysisItem): string =>
  blockPrint({
    value: item.value,
    sources: item.pendingSources ?? null,
    links: item.pendingLinks ?? null,
  });

/** Шаг, который пишет темы и их связи с героями и цитатами (`themeLinks`). */
export const THEMES_STEP = (Object.keys(STEP_TARGETS).map(Number) as AnalysisStepNumber[]).find(
  (step) => STEP_TARGETS[step].includes('themes'),
) as AnalysisStepNumber;

/** Содержимое единицы записи в сохранённом анализе: блок или подполе `facts`. */
export function targetValue(stored: StoredBookAnalysis, target: AnalysisTarget): unknown {
  const field = factField(target);
  if (field) return stored.facts?.[field] ?? null;
  return stored[target as Exclude<AnalysisTarget, `facts.${string}`>] ?? null;
}

/** Содержимое единицы записи в итоге шага: блок или подполе `facts`; нет - `undefined`. */
export function blocksValue(blocks: StepBlocks, target: AnalysisTarget): unknown {
  const field = factField(target);
  if (field) return blocks.facts?.[field] ?? undefined;
  return blocks[target as keyof StepBlocks];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
const stepOf = (v: unknown): AnalysisStepNumber | null =>
  v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : null;

function remarkOf(v: unknown): DraftRemark[] {
  if (!isRecord(v)) return [];
  const code = oneOf<DraftRemarkCode>(DRAFT_REMARK_CODES, v.code);
  const by = oneOf(['code', 'model'] as const, v.by);
  const where = str(v.where);
  const note = str(v.note);
  return code && by && where !== null && note !== null ? [{ code, where, note, by }] : [];
}

const remarksOf = (v: unknown): DraftRemark[] => (Array.isArray(v) ? v.flatMap(remarkOf) : []);

function reviewOf(v: unknown): ReviewState | null {
  if (!isRecord(v)) return null;
  const kind = oneOf(ANALYSIS_REVIEW_KINDS, v.kind);
  if (kind === 'answered') {
    const model = str(v.model);
    return model === null ? null : { kind, model };
  }
  return kind === null ? null : { kind };
}

function fixesOf(v: unknown): StepFix[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((f) => {
    if (!isRecord(f)) return [];
    const code = oneOf(STEP_FIX_CODES, f.code);
    const path = str(f.path);
    const note = str(f.note);
    return code && path !== null && note !== null ? [{ code, path, note }] : [];
  });
}

function droppedOf(v: unknown): Array<Omit<DroppedQuote, 'step'>> {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    if (!isRecord(d)) return [];
    const path = str(d.path);
    const text = str(d.text);
    const reason = oneOf(QUOTE_CHECK_REASONS, d.reason);
    const chapter = Number.isInteger(d.chapter) ? (d.chapter as number) : null;
    return path !== null && text !== null && reason ? [{ path, text, chapter, reason }] : [];
  });
}

function linkMap(v: unknown): Record<string, string[]> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(
    Object.entries(v).flatMap(([key, keys]) =>
      Array.isArray(keys)
        ? [[key, keys.filter((k): k is string => typeof k === 'string')] as const]
        : [],
    ),
  );
}

function linksOf(v: unknown): ThemeLinks | null {
  if (!isRecord(v)) return null;
  return { characters: linkMap(v.characters), keyQuotes: linkMap(v.keyQuotes) };
}

/**
 * Блоки шагов из данных хода: их пишет только код после проверок импорта, поэтому форма
 * блока не переразбирается - берутся только известные ключи.
 */
function blocksOf(v: unknown): StepBlocks {
  if (!isRecord(v)) return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    'facts',
    'characters',
    'keyQuotes',
    'style',
    'mainIdea',
    'themes',
    'symbols',
    'titleMeaning',
    'endingMeaning',
    'misreadings',
    'discussionQuestions',
    'faq',
    'context',
    'timeline',
    'reception',
    'adaptations',
    'sources',
  ]) {
    const value = v[key];
    if (value === undefined || value === null) continue;
    const textBlock = [
      'mainIdea',
      'titleMeaning',
      'endingMeaning',
      'context',
      'reception',
    ].includes(key);
    const listBlock = [
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
    ].includes(key);
    if (textBlock && typeof value === 'string') out[key] = value;
    if (listBlock && Array.isArray(value)) out[key] = value;
    if (key === 'facts' && isRecord(value)) out[key] = value;
  }
  return out as StepBlocks;
}

/** Ссылки утверждения на источники: неотрицательные целые; прочее - не ссылка. Одно правило у разбора ответа и у чтения данных хода. */
export const refIndexes = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0) : [];
const refLists = (v: unknown): number[][] => (Array.isArray(v) ? v.map(refIndexes) : []);

function refsOf(v: unknown): SourceRefs | null {
  if (!isRecord(v)) return null;
  const facts = isRecord(v.facts) ? v.facts : {};
  return {
    facts: Object.fromEntries(EXTERNAL_FACTS.map((f) => [f, refIndexes(facts[f])])),
    context: refLists(v.context),
    reception: refLists(v.reception),
    timeline: refLists(v.timeline),
    adaptations: refLists(v.adaptations),
  };
}

function droppedSourcesOf(v: unknown): DroppedSource[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    if (!isRecord(d)) return [];
    const title = str(d.title);
    const host = str(d.host);
    const reason = oneOf(['SOURCE_UNREACHABLE', 'SOURCE_UNRELATED'] as const, d.reason);
    return title !== null && host !== null && reason ? [{ title, host, reason }] : [];
  });
}

/** Текст шага из `pending` или итога проверки; не той формы - `null`. */
function stepDraftOf(v: unknown): StepDraft | null {
  if (!isRecord(v) || !isRecord(v.blocks)) return null;
  return {
    blocks: blocksOf(v.blocks),
    themeLinks: linksOf(v.themeLinks),
    refs: refsOf(v.refs),
    droppedQuotes: droppedOf(v.droppedQuotes),
    fixes: fixesOf(v.fixes),
  };
}

function pendingOf(v: unknown): PendingStep | null {
  if (!isRecord(v) || !isRecord(v.resume)) return null;
  const key = str(v.key);
  const operationId = str(v.operationId);
  const draft = stepDraftOf(v.resume.draft);
  const authorModel = str(v.resume.authorModel);
  const attempt = v.resume.attempt === 1 || v.resume.attempt === 2 ? v.resume.attempt : null;
  if (key === null || operationId === null || draft === null || !authorModel || !attempt) {
    return null;
  }
  const checked = isRecord(v.resume.checked) ? v.resume.checked : null;
  const review = checked ? reviewOf(checked.review) : null;
  return {
    key,
    operationId,
    resume: {
      draft,
      attempt,
      authorModel,
      ...(checked && review ? { checked: { remarks: remarksOf(checked.remarks), review } } : {}),
    },
  };
}

function stepRecordOf(v: unknown): AnalysisStep[] {
  if (!isRecord(v)) return [];
  const step = stepOf(v.step);
  const verdict = oneOf(ANALYSIS_VERDICTS, v.verdict);
  const outcome = oneOf(STEP_OUTCOMES, v.outcome);
  if (!step || !verdict || !outcome) return [];
  return [
    {
      step,
      verdict,
      remarks: remarksOf(v.remarks),
      attempt: v.attempt === 2 ? 2 : 1,
      outcome,
      failedReason: str(v.failedReason),
      authorModel: str(v.authorModel),
      review: reviewOf(v.review),
      source: oneOf(STEP_SOURCES, v.source),
      dropped: fixesOf(v.dropped),
    },
  ];
}

function brokenItem(v: unknown): AnalysisItem {
  const r = isRecord(v) ? v : {};
  return {
    target: oneOf(ANALYSIS_TARGETS, r.target) ?? 'characters',
    step: stepOf(r.step) ?? 1,
    verdict: 'failed',
    remarks: [],
    review: null,
    outcome: 'none',
    hash: null,
    value: null,
    failedReason: DRAFT_DATA_INVALID,
    links: false,
    regen: null,
    regenFailedReason: null,
    broken: v ?? null,
  };
}

function itemOf(v: unknown): AnalysisItem {
  if (!isRecord(v)) return brokenItem(v);
  const target = oneOf(ANALYSIS_TARGETS, v.target);
  const step = stepOf(v.step);
  const verdict = oneOf(ANALYSIS_VERDICTS, v.verdict);
  const outcome = oneOf(ANALYSIS_ITEM_OUTCOMES, v.outcome);
  if (!target || !step || !verdict || !outcome) return brokenItem(v);
  return {
    target,
    step,
    verdict,
    remarks: remarksOf(v.remarks),
    review: reviewOf(v.review),
    outcome,
    hash: str(v.hash),
    value: v.value ?? null,
    failedReason: str(v.failedReason),
    links: v.links === true,
    regen: regenOf(v.regen),
    regenFailedReason: str(v.regenFailedReason),
    pendingDropped: Array.isArray(v.pendingDropped) ? droppedQuotesOf(v.pendingDropped) : null,
    pendingLinks: linksOf(v.pendingLinks),
    pendingSources: sourceListOf(v.pendingSources),
  };
}

/** Источник анализа (`title`, `url`): элемент блока `sources`. */
export type AnalysisSource = NonNullable<StoredBookAnalysis['sources']>[number];

/** Список источников из данных хода: элементы без строк `title` и `url` не берутся. */
function sourceListOf(v: unknown): AnalysisSource[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((source) =>
    isRecord(source) && typeof source.title === 'string' && typeof source.url === 'string'
      ? [{ title: source.title, url: source.url } as AnalysisSource]
      : [],
  );
}

/**
 * Сохранённые источники и новые без повторов по адресу (решение арбитра `F07 | F07-2b`, п.1):
 * старые не удаляются, порядок - сохранённые, затем новые.
 */
export function withSources(
  stored: readonly AnalysisSource[] | null | undefined,
  added: readonly AnalysisSource[],
): AnalysisSource[] {
  const out = [...(stored ?? [])];
  const keys = new Set(out.map((source) => sourceKey(source.url)));
  for (const source of added) {
    const key = sourceKey(source.url);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(source);
  }
  return out;
}

/**
 * Один адрес источника в разных записях: без схемы и якоря, хост без регистра и без `www.`, путь
 * без конечной косой черты (`http://www.En.wikipedia.org/wiki/X/` = `https://en.wikipedia.org/wiki/X`);
 * порт - часть адреса. Не адрес - строка как есть.
 */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname.replace(/\/+$/, '');
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${parsed.port ? `:${parsed.port}` : ''}${path}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

function regenOf(v: unknown): AnalysisRegen | null {
  if (!isRecord(v)) return null;
  const operationId = str(v.operationId);
  if (operationId === null) return null;
  const previous = isRecord(v.previous) ? itemOf(v.previous) : null;
  return {
    operationId,
    remark: str(v.remark),
    pending: pendingOf(v.pending),
    previous: previous && !('broken' in previous) ? { ...previous, regen: null } : null,
  };
}

/** Блоки шага из одной единицы записи: блок или подполе `facts`; нет значения - пусто. */
export function targetBlocks(target: AnalysisTarget, value: unknown): StepBlocks {
  if (value === undefined) return {};
  const field = factField(target);
  return (field ? { facts: { [field]: value } } : { [target]: value }) as StepBlocks;
}

/** Блоки шага без единицы записи `target` (у `facts` - без подполя). */
export function withoutTarget(blocks: StepBlocks, target: AnalysisTarget): StepBlocks {
  const field = factField(target);
  const out: Record<string, unknown> = { ...blocks };
  if (!field) {
    delete out[target];
    return out as StepBlocks;
  }
  if (!blocks.facts) return blocks;
  const facts: Record<string, unknown> = { ...blocks.facts };
  delete facts[field];
  if (Object.keys(facts).length > 0) out.facts = facts;
  else delete out.facts;
  return out as StepBlocks;
}

/** Итоги шага поверх итогов прошлых шагов; `facts` - по подполям. */
export function mergeSteps(merged: StepBlocks, blocks: StepBlocks): StepBlocks {
  const out: StepBlocks = { ...merged, ...blocks };
  if (merged.facts && blocks.facts) out.facts = { ...merged.facts, ...blocks.facts };
  return out;
}

/**
 * Основа перегенерации в промпт (`tech.md` §2:42): у блока в анализе (записан ходом или принят) -
 * сохранённое содержимое, с ключами, которые мог добавить редактор; у предложения и не записанного -
 * содержимое хода, а нет его - сохранённое.
 */
export function regenBase(item: AnalysisItem, stored: StoredBookAnalysis): unknown {
  const saved = targetValue(stored, item.target);
  if (item.outcome === 'written' || item.outcome === 'accepted') return saved;
  return item.value ?? saved;
}

/** Итог перегенерации блока: содержимое, флаги блока и выброшенные цитаты. */
export interface RegenResult {
  value: unknown;
  verdict: AnalysisVerdict;
  remarks: DraftRemark[];
  review: ReviewState | null;
  droppedQuotes: DroppedQuote[];
  /** Связи тем ответа (перегенерация тем), иначе `null`. */
  links?: ThemeLinks | null;
  /** Проверенные источники блока шага 5, иначе `null`. */
  sources?: AnalysisSource[] | null;
}

/**
 * Итог перегенерации в данных хода: блок ждёт решения о записи (`settleStep` с `only`), прежний
 * блок - в `regen.previous` (отмена до решения его вернёт, `withoutRegen`). `merged` и
 * `droppedQuotes` хода итог не меняет, пока он не в анализе (`withRegenTaken`): отброшенный итог не
 * уходит в промпты и проверки следующих перегенераций. Запись шага (`steps[]`) не меняется: она -
 * итог шага хода, флаги перегенерации - у блока.
 */
export function withRegenerated(
  data: AnalysisWriteData,
  index: number,
  result: RegenResult,
): AnalysisWriteData {
  const current = data.items[index];
  return withItem(data, index, {
    verdict: result.verdict,
    remarks: result.remarks,
    review: result.review,
    outcome: 'waiting',
    hash: null,
    value: result.value,
    failedReason: null,
    regenFailedReason: null,
    pendingDropped: result.droppedQuotes,
    pendingLinks: result.links ?? null,
    pendingSources: result.sources ?? null,
    regen: current.regen
      ? { ...current.regen, pending: null, previous: { ...current, regen: null } }
      : null,
  });
}

/**
 * Блок без отметки перегенерации: ждущий итог (`waiting`) не решён - блок как до неё
 * (`previous`); `failedReason` - причина, почему перегенерация не дала текста.
 */
export function withoutRegen(
  data: AnalysisWriteData,
  index: number,
  failedReason: string | null,
): AnalysisWriteData {
  const current = data.items[index];
  const restored =
    current.outcome === 'waiting' && current.regen?.previous ? current.regen.previous : current;
  return withItem(data, index, {
    ...restored,
    regen: null,
    pendingDropped: restored.pendingDropped ?? null,
    regenFailedReason: failedReason ?? restored.regenFailedReason,
  });
}

/**
 * Итог перегенерации в анализе (записан или принят «Accept»): в `merged` хода - значение, которое
 * фактически записано в анализ (`written`, с влитыми `themeKeys`), выброшенные цитаты этой единицы
 * записи и шага - итога. Блок не из перегенерации - данные как есть.
 */
export function withRegenTaken(
  data: AnalysisWriteData,
  index: number,
  written: unknown,
): AnalysisWriteData {
  const item = data.items[index];
  if (!item?.pendingDropped) return data;
  return {
    ...withItem(data, index, {
      pendingDropped: null,
      pendingLinks: null,
      pendingSources: null,
    }),
    // Связи новых тем входят в связи хода только взятым итогом (решение арбитра `F07 | F07-2b`,
    // п.3) - слиянием по герою и цитате: пустой ответ о связях не стирает связи, на которых стоят
    // ещё не принятые предложения героев и цитат.
    themeLinks: item.pendingLinks
      ? mergedLinks(data.themeLinks, item.pendingLinks)
      : data.themeLinks,
    merged: mergeSteps(data.merged, targetBlocks(item.target, written)),
    droppedQuotes: [
      ...data.droppedQuotes.filter(
        (d) => !(d.step === item.step && pathInTarget(d.path, item.target)),
      ),
      ...item.pendingDropped,
    ],
  };
}

/** Правки кода шага `step` (`steps[].dropped`): новые заменяют прежние с тем же кодом и путём. */
export function withStepFixes(
  steps: AnalysisWriteData['steps'],
  step: AnalysisStepNumber,
  fixes: readonly StepFix[],
): AnalysisWriteData['steps'] {
  if (fixes.length === 0) return steps;
  const key = (fix: StepFix) => `${fix.code}\u0000${fix.path}`;
  const fresh = new Set(fixes.map(key));
  return steps.map((s) =>
    s.step === step
      ? { ...s, dropped: [...s.dropped.filter((f) => !fresh.has(key(f))), ...fixes] }
      : s,
  );
}

/**
 * Причины, по которым перегенерация сняла источники и утверждения (решение арбитра `F07 | F07-2b`,
 * круг 3, Q2): сразу при итоге, что бы с ним ни стало, - в правки шага блока (замена по коду и пути)
 * и в отброшенные источники хода (без повторов). Контракт не меняется: поля те же, что у шага.
 */
export function withRegenDropped(
  data: AnalysisWriteData,
  step: AnalysisStepNumber,
  fixes: readonly StepFix[],
  dropped: readonly DroppedSource[],
): AnalysisWriteData {
  const key = (source: DroppedSource) =>
    `${source.title}\u0000${source.host}\u0000${source.reason}`;
  const known = new Set(data.droppedSources.map(key));
  // Пути `sources.N` перегенерации - по её собственному списку источников, а не по списку шага:
  // замена по коду и пути затёрла бы причину хода о другом источнике. Такие причины добавляются,
  // совпавшая целиком не повторяется (решение арбитра `F07 | F07-2b`, круг 4).
  const bySource = (fix: StepFix) => /^sources(\.|$)/.test(fix.path);
  const full = (fix: StepFix) => `${fix.code}\u0000${fix.path}\u0000${fix.note}`;
  const present = new Set(
    data.steps.filter((s) => s.step === step).flatMap((s) => s.dropped.map(full)),
  );
  const added = fixes.filter((fix) => bySource(fix) && !present.has(full(fix)));
  const replaced = withStepFixes(
    data.steps,
    step,
    fixes.filter((fix) => !bySource(fix)),
  );
  return {
    ...data,
    steps:
      added.length === 0
        ? replaced
        : replaced.map((s) => (s.step === step ? { ...s, dropped: [...s.dropped, ...added] } : s)),
    droppedSources: [
      ...data.droppedSources,
      ...dropped.filter((source) => !known.has(key(source))),
    ],
  };
}

/** Связи тем `added` поверх `base`: ключи тем героя или цитаты объединяются, порядок - прежние, затем новые. */
export function mergedLinks(base: ThemeLinks | null, added: ThemeLinks): ThemeLinks {
  const merge = (prior: Record<string, string[]>, extra: Record<string, string[]>) => {
    const out: Record<string, string[]> = { ...prior };
    for (const [id, keys] of Object.entries(extra)) {
      out[id] = [...new Set([...(out[id] ?? []), ...keys])];
    }
    return out;
  };
  return {
    characters: merge(base?.characters ?? {}, added.characters),
    keyQuotes: merge(base?.keyQuotes ?? {}, added.keyQuotes),
  };
}

/** Данные хода с заменённым элементом `index` (правка полей, остальное - как есть). */
export function withItem(
  data: AnalysisWriteData,
  index: number,
  patch: Partial<AnalysisItem>,
): AnalysisWriteData {
  return {
    ...data,
    items: data.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
  };
}

function flagsOf<T>(
  v: unknown,
  read: (x: unknown) => T | null,
): Partial<Record<AnalysisTarget, T>> {
  if (!isRecord(v)) return {};
  const out: Partial<Record<AnalysisTarget, T>> = {};
  for (const target of ANALYSIS_TARGETS) {
    const value = read(v[target]);
    if (value !== null) out[target] = value;
  }
  return out;
}

function droppedQuotesOf(v: unknown): DroppedQuote[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    const step = isRecord(d) ? stepOf(d.step) : null;
    const [quote] = droppedOf([d]);
    return step && quote ? [{ step, ...quote }] : [];
  });
}

/** Данные хода из `ContentDraft.data`; не той формы - пустой ход без права на блоки. */
export function readAnalysisData(data: unknown): AnalysisWriteData {
  const d = isRecord(data) ? data : {};
  const raw = d.steps === undefined ? [] : d.steps;
  const steps = Array.isArray(raw) ? raw.flatMap(stepRecordOf) : [];
  const stepsBroken =
    !Array.isArray(raw) || steps.length !== raw.length || steps.some((s, i) => s.step !== i + 1);
  return {
    steps,
    stepsBroken,
    items: Array.isArray(d.items) ? d.items.map(itemOf) : [],
    merged: blocksOf(d.merged),
    themeLinks: linksOf(d.themeLinks),
    droppedQuotes: droppedQuotesOf(d.droppedQuotes),
    droppedSources: droppedSourcesOf(d.droppedSources),
    stepsTotal:
      Number.isInteger(d.stepsTotal) &&
      (d.stepsTotal as number) >= LEGACY_ANALYSIS_STEPS &&
      (d.stepsTotal as number) <= ANALYSIS_STEPS
        ? (d.stepsTotal as number)
        : LEGACY_ANALYSIS_STEPS,
    owns: flagsOf(d.owns, (v) => (v === true ? true : v === false ? false : null)),
    written: flagsOf(d.written, str),
    pending: pendingOf(d.pending),
  };
}

/** Данные хода в `ContentDraft.data`: элемент не той формы уходит назад как был прочитан. */
export const analysisDataJson = (data: AnalysisWriteData): Prisma.InputJsonValue =>
  ({
    steps: data.steps,
    items: data.items.map((item) => ('broken' in item ? item.broken : item)),
    merged: data.merged,
    themeLinks: data.themeLinks,
    droppedQuotes: data.droppedQuotes,
    droppedSources: data.droppedSources,
    stepsTotal: data.stepsTotal,
    owns: data.owns,
    written: data.written,
    pending: data.pending,
  }) as unknown as Prisma.InputJsonValue;

/** Ключ шага для сохранённого текста. */
export const stepKey = (step: AnalysisStepNumber): string => `step:${step}`;
