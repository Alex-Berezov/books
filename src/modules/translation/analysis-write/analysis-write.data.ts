import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import type { StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { FillableFact } from '../content-draft/content-draft.analysis';
import { DRAFT_DATA_INVALID } from '../content-draft/content-draft.constants';
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
] as const;
export type AnalysisTarget = (typeof ANALYSIS_TARGETS)[number];

export type AnalysisStepNumber = 1 | 2 | 3;

/** Блоки, которые пишет шаг (`product.md` §2); `themeKeys` шага 3 - отдельными элементами. */
export const STEP_TARGETS: Record<AnalysisStepNumber, readonly AnalysisTarget[]> = {
  1: ['facts.settingPlace', 'facts.settingTime', 'facts.narrator', 'facts.structure', 'characters'],
  2: ['keyQuotes', 'style'],
  3: ['mainIdea', 'themes', 'symbols', 'titleMeaning', 'endingMeaning'],
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
    | 'endingMeaning']: NonNullable<StoredBookAnalysis[K]>;
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
] as const satisfies readonly DraftRemarkCode[];
export type StepFixCode = (typeof STEP_FIX_CODES)[number];

export interface StepFix {
  code: StepFixCode;
  path: string;
  note: string;
}

/** Ответ шага после правок кода - то, что видят код-проверки, проверяющая и запись. */
export interface StepDraft {
  blocks: StepBlocks;
  /** Только у шага 3. */
  themeLinks: ThemeLinks | null;
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
  droppedQuotes: [],
  fixes: [],
};

export const STEP_OUTCOMES = ['done', 'failed'] as const;

/** Откуда шаг брал книгу: весь текст версии или краткое содержание глав досье (`tech.md` §2). */
export const STEP_SOURCES = ['text', 'summaries'] as const;
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
  /** Элемент не той формы - сохранён как был, место в `items` не сдвигается. */
  broken?: unknown;
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

/** Содержимое единицы записи в сохранённом анализе: блок или подполе `facts`. */
export function targetValue(stored: StoredBookAnalysis, target: AnalysisTarget): unknown {
  if (target.startsWith('facts.')) {
    const field = target.slice('facts.'.length) as FillableFact;
    return stored.facts?.[field] ?? null;
  }
  return stored[target as Exclude<AnalysisTarget, `facts.${string}`>] ?? null;
}

/** Содержимое единицы записи в итоге шага: блок или подполе `facts`; нет - `undefined`. */
export function blocksValue(blocks: StepBlocks, target: AnalysisTarget): unknown {
  if (target.startsWith('facts.')) {
    const field = target.slice('facts.'.length) as FillableFact;
    return blocks.facts?.[field] ?? undefined;
  }
  return blocks[target as keyof StepBlocks];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
const stepOf = (v: unknown): AnalysisStepNumber | null =>
  v === 1 || v === 2 || v === 3 ? v : null;

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
  ]) {
    const value = v[key];
    if (value === undefined || value === null) continue;
    const textBlock = ['mainIdea', 'titleMeaning', 'endingMeaning'].includes(key);
    const listBlock = ['characters', 'keyQuotes', 'style', 'themes', 'symbols'].includes(key);
    if (textBlock && typeof value === 'string') out[key] = value;
    if (listBlock && Array.isArray(value)) out[key] = value;
    if (key === 'facts' && isRecord(value)) out[key] = value;
  }
  return out as StepBlocks;
}

/** Текст шага из `pending` или итога проверки; не той формы - `null`. */
function stepDraftOf(v: unknown): StepDraft | null {
  if (!isRecord(v) || !isRecord(v.blocks)) return null;
  return {
    blocks: blocksOf(v.blocks),
    themeLinks: linksOf(v.themeLinks),
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
    owns: data.owns,
    written: data.written,
    pending: data.pending,
  }) as unknown as Prisma.InputJsonValue;

/** Ключ шага для сохранённого текста. */
export const stepKey = (step: AnalysisStepNumber): string => `step:${step}`;
