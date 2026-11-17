import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { stableJson } from '../../../shared/json/stable-json';
import { compactBlock } from '../../../shared/prisma/compact-block.util';
import type { BookAnalysisSourceDto } from '../../book-analysis/dto/book-analysis-blocks.dto';
import type { StoredWorldEntity } from '../../book-world/book-world-data';
import { intOf, oneOf, remarksReader, reviewReader, stringOf } from '../draft-quality/draft-record';
import type { QualityLoopResume, ReviewState } from '../draft-quality/quality-loop';
import { DRAFT_REMARK_CODES, DraftRemark } from '../draft-quality/text-checks';

/**
 * Данные хода «Write World» в `ContentDraft.data` (`F08-4a`; `features/F08-book-wiki/tech.md` §5).
 * Шаг 0 - выбор героев и форм имени; дальше на каждого кандидата - страница и внешние блоки. Пункт
 * хода - блок одной сущности (гранулярность предложения, `tech.md` §5).
 */

/** Блоки, которые пишет шаг страницы; `aliases` - итог выбора героев, пишется вместе со страницей. */
export const WORLD_PAGE_BLOCKS = [
  'aliases',
  'short',
  'profile',
  'appearance',
  'character',
  'arc',
  'scenes',
  'relations',
  'quotes',
  'faq',
] as const;
/** Блоки внешнего шага: только с проверенным источником (`product.md` §5, правило 6 канона). */
export const WORLD_EXTERNAL_BLOCKS = ['critique', 'prototypes', 'adaptations'] as const;
export const WORLD_BLOCKS = [...WORLD_PAGE_BLOCKS, ...WORLD_EXTERNAL_BLOCKS] as const;
/** Блоки-тексты: предложение отдаётся полем `text` (`WorldWriteValueDto`). */
export const WORLD_TEXT_BLOCKS: ReadonlySet<string> = new Set([
  'short',
  'appearance',
  'character',
  'critique',
  'prototypes',
]);
export type WorldPageBlock = (typeof WORLD_PAGE_BLOCKS)[number];
export type WorldExternalBlock = (typeof WORLD_EXTERNAL_BLOCKS)[number];
export type WorldBlock = (typeof WORLD_BLOCKS)[number];

export const WORLD_STEP_KINDS = ['select', 'page', 'external'] as const;
export type WorldStepKind = (typeof WORLD_STEP_KINDS)[number];

/** Шаг по номеру: 0 - выбор, затем на кандидата `i` - страница (`1 + 2i`) и внешние блоки (`2 + 2i`). */
export function stepAt(step: number): { kind: WorldStepKind; candidate: number | null } {
  if (step === 0) return { kind: 'select', candidate: null };
  return {
    kind: (step - 1) % 2 === 0 ? 'page' : 'external',
    candidate: Math.floor((step - 1) / 2),
  };
}

/** Присутствие героя, посчитанное кодом до страницы (`tech.md` §4-§5): главы и число вхождений. */
export interface CandidateMentions {
  chapters: number[];
  perChapter: Record<string, number>;
}

/** Кандидат хода: герой `main` анализа версии (решение арбитра `F08 | F08-4`, Q3). */
export interface WorldCandidate {
  key: string;
  /** Имя героя: из ответа выбора героев, иначе сохранённой сущности, иначе анализа версии. */
  name: string;
  /** Формы имени после проверки по тексту версии (выбор героев). */
  aliases: string[];
  mentions: CandidateMentions;
}

/** Код снял элемент ответа или ответ целиком (видно редактору: что и почему). */
export const WORLD_FIX_CODES = [
  'IMPORT_INVALID',
  'CHAPTER_UNKNOWN',
  'LIMIT_OUT',
  'QUOTE_NOT_VERBATIM',
  'ALIAS_NOT_IN_TEXT',
  'KEY_UNKNOWN',
  'SOURCE_UNREACHABLE',
  'SOURCE_UNRELATED',
  'SOURCE_UNVERIFIED',
] as const;
export type WorldFixCode = (typeof WORLD_FIX_CODES)[number];

export interface WorldFix {
  code: WorldFixCode;
  /** Путь в ответе шага (`quotes.3`, `aliases.2`, `sources.1`). */
  path: string;
  note: string;
}

/** Цитата, которую код выбросил: дословно её в главе нет или глава не версии. */
export interface DroppedWorldQuote {
  key: string;
  chapter: number | null;
  text: string;
  reason: 'QUOTE_NOT_VERBATIM' | 'CHAPTER_UNKNOWN';
}

/** Источник внешнего шага, который не прошёл проверку кода (не открылся или не про книгу). */
export interface DroppedWorldSource {
  key: string;
  title: string;
  host: string;
  reason: 'SOURCE_UNREACHABLE' | 'SOURCE_UNRELATED';
}

export type WorldSource = BookAnalysisSourceDto;

export const WORLD_VERDICTS = ['ok', 'flags', 'failed'] as const;
export type WorldVerdict = (typeof WORLD_VERDICTS)[number];

export const WORLD_REVIEW_KINDS = [
  'answered',
  'not_independent',
  'too_long',
  'invalid',
  'no_provider',
  'unavailable',
] as const satisfies ReadonlyArray<ReviewState['kind']>;

/** Откуда страница брала текст: главы с героем, главы с наибольшим числом упоминаний, ничего. */
export const WORLD_STEP_SOURCES = ['text', 'top', 'none'] as const;
export type WorldStepSource = (typeof WORLD_STEP_SOURCES)[number];

export interface WorldStep {
  step: number;
  kind: WorldStepKind;
  /** Ключ кандидата; у выбора героев - `null`. */
  key: string | null;
  verdict: WorldVerdict;
  remarks: DraftRemark[];
  attempt: 1 | 2;
  outcome: 'done' | 'failed';
  failedReason: string | null;
  authorModel: string | null;
  review: ReviewState | null;
  source: WorldStepSource | null;
  dropped: WorldFix[];
}

/**
 * Судьба пункта: `waiting` - итог шага сохранён, запись не решена (обрыв дописывает её следующей
 * задачей); `written` - в сущности; `proposed` - предложение редактору; `accepted`/`discarded` -
 * решение редактора; `none` - не записан (`failedReason`).
 */
export const WORLD_ITEM_OUTCOMES = [
  'waiting',
  'written',
  'proposed',
  'accepted',
  'discarded',
  'none',
] as const;
export type WorldItemOutcome = (typeof WORLD_ITEM_OUTCOMES)[number];

/** Перегенерация блока хода `ready` своей операцией (как у хода анализа, `F07-1b`). */
export interface WorldRegen {
  operationId: string;
  remark: string | null;
  pending: PendingWorldStep | null;
  /** Пункт до итога перегенерации: отмена до решения возвращает его. */
  previous: WorldItem | null;
}

export interface WorldItem {
  key: string;
  block: WorldBlock;
  step: number;
  verdict: WorldVerdict;
  remarks: DraftRemark[];
  review: ReviewState | null;
  outcome: WorldItemOutcome;
  /** Значение блока, которое ход пишет или предлагает. */
  value: unknown;
  /** Проверенные источники внешнего блока: вливаются в `sources` сущности его записью. */
  sources: WorldSource[] | null;
  /** Имя новой сущности: пункт страницы создаёт её, если её нет. */
  name: string | null;
  /** Отпечаток блока сущности на момент предложения: «Accept» сверяет, что его не меняли. */
  base: string | null;
  failedReason: string | null;
  regen: WorldRegen | null;
  regenFailedReason: string | null;
}

export interface PendingWorldStep {
  key: string;
  operationId: string;
  resume: QualityLoopResume<unknown>;
}

export interface WorldWriteData {
  /** Кандидаты; `null` - выбор героев ещё не прошёл. */
  candidates: WorldCandidate[] | null;
  steps: WorldStep[];
  items: WorldItem[];
  droppedQuotes: DroppedWorldQuote[];
  droppedSources: DroppedWorldSource[];
  pending: PendingWorldStep | null;
  /** Записи шагов не той формы или не по порядку: следующий шаг не вывести (в данные не пишется). */
  stepsBroken: boolean;
}

export const emptyWorldData = (): WorldWriteData => ({
  candidates: null,
  steps: [],
  items: [],
  droppedQuotes: [],
  droppedSources: [],
  pending: null,
  stepsBroken: false,
});

/** Шагов в ходе: выбор и по два на кандидата; до выбора - неизвестно (`null`). */
export const stepsTotalOf = (data: Pick<WorldWriteData, 'candidates'>): number | null =>
  data.candidates === null ? null : 1 + data.candidates.length * 2;

/**
 * Отпечаток значения блока в хранимом виде (`compactBlock`, как его пишет импорт мира): sha256
 * стабильной сериализации; пустой блок - отпечаток `null`. Так значение хода и блок сущности,
 * в который оно записано, дают один отпечаток.
 */
export const valuePrint = (value: unknown): string =>
  createHash('sha256')
    .update(stableJson(compactBlock(value)))
    .digest('hex');

/** Отпечаток предложения: всё, что вносит его «Accept», - значение и источники. */
export const proposalPrint = (item: Pick<WorldItem, 'value' | 'sources'>): string =>
  valuePrint({ value: item.value, sources: item.sources ?? null });

/** Пустой блок сущности: нет значения, пустая строка или пустой список. */
export function blockIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.values(value).every(blockIsEmpty);
  return false;
}

/** Значение блока сущности (хранимый вид). */
export const entityBlock = (entity: StoredWorldEntity, block: WorldBlock): unknown =>
  entity[block] ?? null;

export function withItem(
  data: WorldWriteData,
  index: number,
  patch: Partial<WorldItem>,
): WorldWriteData {
  return {
    ...data,
    items: data.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
  };
}

/** Пункт без отметки перегенерации: несрешённый итог (`waiting`) - пункт как до неё. */
export function withoutRegen(
  data: WorldWriteData,
  index: number,
  failedReason: string | null,
): WorldWriteData {
  const current = data.items[index];
  const restored =
    current.outcome === 'waiting' && current.regen?.previous ? current.regen.previous : current;
  return withItem(data, index, {
    ...restored,
    regen: null,
    regenFailedReason: failedReason ?? restored.regenFailedReason,
  });
}

const remarksOf = remarksReader(DRAFT_REMARK_CODES);
const reviewOf = reviewReader(WORLD_REVIEW_KINDS);
const fixesOf = (v: unknown): WorldFix[] =>
  Array.isArray(v)
    ? v.flatMap((f) => {
        if (!isRecord(f)) return [];
        const code = oneOf(WORLD_FIX_CODES, f.code);
        const path = stringOf(f.path);
        const note = stringOf(f.note);
        return code && path !== null && note !== null ? [{ code, path, note }] : [];
      })
    : [];

const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

function mentionsOf(v: unknown): CandidateMentions {
  if (!isRecord(v)) return { chapters: [], perChapter: {} };
  const chapters = Array.isArray(v.chapters) ? v.chapters.flatMap((n) => intOf(n) ?? []) : [];
  const perChapter: Record<string, number> = {};
  if (isRecord(v.perChapter)) {
    for (const [k, n] of Object.entries(v.perChapter)) {
      const count = intOf(n);
      if (count !== null) perChapter[k] = count;
    }
  }
  return { chapters, perChapter };
}

function candidatesOf(v: unknown): WorldCandidate[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((c) => {
    if (!isRecord(c)) return [];
    const key = stringOf(c.key);
    const name = stringOf(c.name);
    if (key === null || name === null) return [];
    return [{ key, name, aliases: stringsOf(c.aliases), mentions: mentionsOf(c.mentions) }];
  });
}

function stepOf(v: unknown): WorldStep | null {
  if (!isRecord(v)) return null;
  const step = intOf(v.step);
  const kind = oneOf(WORLD_STEP_KINDS, v.kind);
  const verdict = oneOf(WORLD_VERDICTS, v.verdict);
  const outcome = oneOf(['done', 'failed'] as const, v.outcome);
  if (step === null || !kind || !verdict || !outcome) return null;
  return {
    step,
    kind,
    key: stringOf(v.key),
    verdict,
    remarks: remarksOf(v.remarks),
    attempt: v.attempt === 2 ? 2 : 1,
    outcome,
    failedReason: stringOf(v.failedReason),
    authorModel: stringOf(v.authorModel),
    review: reviewOf(v.review),
    source: oneOf(WORLD_STEP_SOURCES, v.source),
    dropped: fixesOf(v.dropped),
  };
}

function pendingOf(v: unknown): PendingWorldStep | null {
  if (!isRecord(v) || !isRecord(v.resume)) return null;
  const key = stringOf(v.key);
  const operationId = stringOf(v.operationId);
  const authorModel = stringOf(v.resume.authorModel);
  if (key === null || operationId === null || authorModel === null) return null;
  const r = v.resume;
  const checked = isRecord(r.checked)
    ? { remarks: remarksOf(r.checked.remarks), review: reviewOf(r.checked.review) }
    : undefined;
  return {
    key,
    operationId,
    resume: {
      draft: r.draft,
      attempt: r.attempt === 2 ? 2 : 1,
      authorModel,
      ...(checked && checked.review ? { checked: { ...checked, review: checked.review } } : {}),
    },
  };
}

function sourcesOf(v: unknown): WorldSource[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((s) => {
    if (!isRecord(s)) return [];
    const title = stringOf(s.title);
    const url = stringOf(s.url);
    return title !== null && url !== null ? [{ title, url }] : [];
  });
}

function itemOf(v: unknown): WorldItem | null {
  if (!isRecord(v)) return null;
  const key = stringOf(v.key);
  const block = oneOf(WORLD_BLOCKS, v.block);
  const step = intOf(v.step);
  const verdict = oneOf(WORLD_VERDICTS, v.verdict);
  const outcome = oneOf(WORLD_ITEM_OUTCOMES, v.outcome);
  if (key === null || !block || step === null || !verdict || !outcome) return null;
  const regen = isRecord(v.regen) ? v.regen : null;
  const regenOp = regen ? stringOf(regen.operationId) : null;
  return {
    key,
    block,
    step,
    verdict,
    remarks: remarksOf(v.remarks),
    review: reviewOf(v.review),
    outcome,
    value: v.value ?? null,
    sources: sourcesOf(v.sources),
    name: stringOf(v.name),
    base: stringOf(v.base),
    failedReason: stringOf(v.failedReason),
    regen:
      regen && regenOp !== null
        ? {
            operationId: regenOp,
            remark: stringOf(regen.remark),
            pending: pendingOf(regen.pending),
            previous: itemOf(regen.previous),
          }
        : null,
    regenFailedReason: stringOf(v.regenFailedReason),
  };
}

function droppedQuotesOf(v: unknown): DroppedWorldQuote[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    if (!isRecord(d)) return [];
    const key = stringOf(d.key);
    const text = stringOf(d.text);
    const reason = oneOf(['QUOTE_NOT_VERBATIM', 'CHAPTER_UNKNOWN'] as const, d.reason);
    return key !== null && text !== null && reason
      ? [{ key, text, reason, chapter: intOf(d.chapter) }]
      : [];
  });
}

function droppedSourcesOf(v: unknown): DroppedWorldSource[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    if (!isRecord(d)) return [];
    const key = stringOf(d.key);
    const title = stringOf(d.title);
    const host = stringOf(d.host);
    const reason = oneOf(['SOURCE_UNREACHABLE', 'SOURCE_UNRELATED'] as const, d.reason);
    return key !== null && title !== null && host !== null && reason
      ? [{ key, title, host, reason }]
      : [];
  });
}

/**
 * Данные хода из `ContentDraft.data`. Пункт не той формы выпадает: номера пунктов в ответе - это
 * индексы в `items`, поэтому `stepsBroken` ставится и тогда - ход не продолжается поверх битых данных.
 */
export function readWorldData(data: unknown): WorldWriteData {
  const d = isRecord(data) ? data : {};
  const rawSteps = Array.isArray(d.steps) ? d.steps : d.steps === undefined ? [] : null;
  const steps = (rawSteps ?? []).flatMap((s) => stepOf(s) ?? []);
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items = rawItems.flatMap((i) => itemOf(i) ?? []);
  const stepsBroken =
    rawSteps === null ||
    steps.length !== rawSteps.length ||
    steps.some((s, i) => s.step !== i) ||
    items.length !== rawItems.length;
  return {
    candidates: candidatesOf(d.candidates),
    steps,
    items,
    droppedQuotes: droppedQuotesOf(d.droppedQuotes),
    droppedSources: droppedSourcesOf(d.droppedSources),
    pending: pendingOf(d.pending),
    stepsBroken,
  };
}

export const worldDataJson = (data: WorldWriteData): Prisma.InputJsonValue =>
  ({
    candidates: data.candidates,
    steps: data.steps,
    items: data.items,
    droppedQuotes: data.droppedQuotes,
    droppedSources: data.droppedSources,
    pending: data.pending,
  }) as unknown as Prisma.InputJsonValue;

/** Ключ оплаченного текста шага хода. */
export const stepKey = (step: number): string => `step:${step}`;
