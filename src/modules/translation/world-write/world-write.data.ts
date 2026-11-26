import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { stableJson } from '../../../shared/json/stable-json';
import { compactBlock } from '../../../shared/prisma/compact-block.util';
import type {
  BookAnalysisRole,
  BookAnalysisSourceDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import {
  WORLD_PAIR_BLOCK_KEYS,
  WORLD_PLACE_BLOCK_KEYS,
  type StoredWorldEntity,
} from '../../book-world/book-world-data';
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
  // ТЗ на иллюстрацию для редакции (`F08-11d-2`, решения `F08 | F08-11d` Q3–Q5): по-английски.
  'imageBrief',
] as const;
/** Блоки внешнего шага: только с проверенным источником (`product.md` §5, правило 6 канона). */
export const WORLD_EXTERNAL_BLOCKS = ['critique', 'prototypes', 'adaptations'] as const;
/**
 * Блоки хода: страница героя, внешние блоки и блоки только пары (`F08-8e`; перечень пары — один на мир
 * книги, `WORLD_PAIR_BLOCK_KEYS`); «Коротко», цитаты и вопросы пары — общие с героем.
 */
export const WORLD_BLOCKS = [
  ...WORLD_PAGE_BLOCKS,
  ...WORLD_EXTERNAL_BLOCKS,
  ...WORLD_PAIR_BLOCK_KEYS,
  // Номер Wikidata пунктом не бывает: он едет в пункте `kind` места (`WorldPlaceKindValue`, R3).
  ...WORLD_PLACE_BLOCK_KEYS.filter((k): k is Exclude<typeof k, 'wikidataId'> => k !== 'wikidataId'),
] as const;
/** Блоки-тексты: предложение отдаётся полем `text` (`WorldWriteValueDto`). */
export const WORLD_TEXT_BLOCKS: ReadonlySet<string> = new Set([
  'short',
  'appearance',
  'character',
  'critique',
  'prototypes',
  'bonds',
  'differences',
  'conclusion',
  'imageBrief',
  'location',
  'significance',
  'description',
]);

/**
 * Значение пункта `kind` места (`F08-12b`, решение арбитра `F08 | F08-12b` R3): вид и номер Wikidata
 * одним предложением - правило сервера «номер только у реального места» (`world-refs.ts`) становится
 * формой пункта, и «Accept» не собирает состояние, которое импорт отбивает 400.
 */
export interface WorldPlaceKindValue {
  kind: string | null;
  wikidataId: string | null;
}
export type WorldPageBlock = (typeof WORLD_PAGE_BLOCKS)[number];
export type WorldExternalBlock = (typeof WORLD_EXTERNAL_BLOCKS)[number];
export type WorldBlock = (typeof WORLD_BLOCKS)[number];

export const WORLD_STEP_KINDS = ['select', 'page', 'external', 'pair', 'place'] as const;
export type WorldStepKind = (typeof WORLD_STEP_KINDS)[number];

/**
 * Шаг по номеру: 0 - выбор, затем на кандидата `i` - страница (`1 + 2i`) и внешние блоки (`2 + 2i`),
 * после всех `heroes` героев - пара `j` (`1 + 2·heroes + j`, `F08-8e`), после всех `pairs` пар - место
 * `k` (`1 + 2·heroes + pairs + k`, `F08-12b`); `candidate` - индекс героя в `candidates`, пары в `pairs`
 * или места в `places`. Номера шагов героев от пар и мест не зависят, шагов пар - от мест.
 * Фронтовая копия нумерации - `stepAhead` в books-front/components/admin/books/WorldTab/WorldWrite/worldWrite.utils.ts;
 * менять вместе.
 */
export function stepAt(
  step: number,
  heroes: number,
  pairs: number,
): { kind: WorldStepKind; candidate: number | null } {
  if (step === 0) return { kind: 'select', candidate: null };
  if (step > 2 * heroes + pairs) return { kind: 'place', candidate: step - 1 - 2 * heroes - pairs };
  if (step > 2 * heroes) return { kind: 'pair', candidate: step - 1 - 2 * heroes };
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

/** Роли анализа, из которых ход берёт кандидатов (`F08-4` Q3, `F08-8b`): `minor` в ход не идёт. */
export const WORLD_CANDIDATE_ROLES = [
  'main',
  'secondary',
] as const satisfies readonly BookAnalysisRole[];
export type WorldCandidateRole = (typeof WORLD_CANDIDATE_ROLES)[number];

/** Кандидат хода: герой `main` или `secondary` анализа версии (`F08-4` Q3, `F08-8b`). */
export interface WorldCandidate {
  key: string;
  /** Роль в анализе на шаге выбора - роль новой сущности; ходы до `F08-8b` брали только `main`. */
  role: WorldCandidateRole;
  /** Имя героя: из ответа выбора героев, иначе сохранённой сущности, иначе анализа версии. */
  name: string;
  /** Формы имени после проверки по тексту версии (выбор героев). */
  aliases: string[];
  mentions: CandidateMentions;
}

/**
 * Кандидат пары (`F08-8e`, решения арбитра `F08 | F08-8e-1` Q1, Q3): два героя-кандидата хода,
 * прошедшие условие заведения (`pairFounded`) по присутствию в памяти на шаге выбора, или уже
 * заведённая пара этих героев. `a` и `b` - герои ключа по алфавиту.
 */
export interface WorldPairCandidate {
  key: string;
  a: string;
  b: string;
  /** Связь героев в `relations` анализа версии (в любую сторону). */
  linked: boolean;
  /** Общие главы героев по подсчёту шага выбора - текст шага пары. */
  chapters: number[];
}

/**
 * Кандидат-место (`F08-12b`, решение арбитра `F08 | F08-12b` Q1): место досье (`kind: 'place'`)
 * с ключом досье, прошедшее порог `WORLD_PLACE_MIN_CHAPTERS` по присутствию и потолок `WORLD_PLACES_MAX`.
 */
export interface WorldPlaceCandidate {
  key: string;
  /** Название: из ответа выбора, иначе сохранённой сущности, иначе досье. */
  name: string;
  /** Формы названия после проверки по тексту версии (выбор). */
  aliases: string[];
  mentions: CandidateMentions;
}

/**
 * Почему герой или пара в ход не попали (видно редактору, без платного вызова): второстепенный ниже
 * порога глав (`F08-8b`), ключ героя вида пары (`LEGACY-507`, Q7), ключ пары не собрать (Q1 `F08-8c`),
 * ключ пары занят сущностью другого типа (Q4), пара за потолком `WORLD_PAIRS_MAX` (Q3).
 */
export const WORLD_SKIP_REASONS = [
  'BELOW_MIN_CHAPTERS',
  'KEY_PAIR_FORM',
  'PAIR_KEY_INVALID',
  'PAIR_KEY_TAKEN',
  'PAIRS_MAX',
  // Места (`F08-12b`, Q1): ниже порога глав, ключ занят сущностью или кандидатом другого типа, за потолком.
  'PLACE_BELOW_MIN_CHAPTERS',
  'PLACE_KEY_TAKEN',
  'PLACES_MAX',
] as const;
export type WorldSkipReason = (typeof WORLD_SKIP_REASONS)[number];

export interface WorldSkip {
  /** Ключ героя или пары; у `PAIR_KEY_INVALID` - ключи героев через `--`, как вышел бы ключ. */
  key: string;
  reason: WorldSkipReason;
  /**
   * Имена для подписи редактору: героя - одно, пары - двух героев в порядке ключа (ключ пары
   * `PAIR_KEY_INVALID` не разобрать); пусто у записи хода до этого поля - подписью служит ключ.
   */
  names: string[];
  /** Главы героя (`BELOW_MIN_CHAPTERS`) или общие главы пары; иначе `null`. */
  chapters: number | null;
}

/** Этапа пар нет у хода: язык без эталона пары (решение арбитра `F08 | F08-8e-1` Q6). */
export const WORLD_PAIRS_OFF_REASONS = ['WORLD_PAIR_LANGUAGE'] as const;
export type WorldPairsOffReason = (typeof WORLD_PAIRS_OFF_REASONS)[number];

/** Этапа мест нет у хода: язык без эталона места (`F08-12b`, как пары - Q6 `F08-8e-1`). */
export const WORLD_PLACES_OFF_REASONS = ['WORLD_PLACE_LANGUAGE'] as const;
export type WorldPlacesOffReason = (typeof WORLD_PLACES_OFF_REASONS)[number];

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
  // ТЗ на иллюстрацию без «Внешности» (решения `F08 | F08-11d` Q10, `F08 | F08-11d-2`): снято кодом.
  'BRIEF_WITHOUT_APPEARANCE',
  // ТЗ у сущности, которой иллюстрация не положена (не герой `main`/`secondary`, Q2): снято кодом.
  'BRIEF_NOT_ALLOWED',
  // ТЗ места без «Описания» (решение `F08 | F08-12b` Q2): снято кодом.
  'BRIEF_WITHOUT_DESCRIPTION',
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
  /**
   * Только у пункта `imageBrief`: отпечаток «Внешности», по которой написано ТЗ (решение
   * `F08 | F08-11d-2`); едет в запись вместе с ТЗ — и сразу, и при «Accept».
   */
  basis?: string | null;
}

export interface PendingWorldStep {
  key: string;
  operationId: string;
  resume: QualityLoopResume<unknown>;
}

export interface WorldWriteData {
  /** Кандидаты; `null` - выбор героев ещё не прошёл. */
  candidates: WorldCandidate[] | null;
  /**
   * Кандидаты пар (`F08-8e`); `null` - выбор ещё не прошёл. Ход, начатый до `F08-8e` (поля пар нет,
   * прошёл ли выбор или нет), читается `[]`: его оценка пар не включала, он кончается на героях.
   */
  pairs: WorldPairCandidate[] | null;
  /**
   * Кандидаты-места (`F08-12b`); `null` - выбор ещё не прошёл. Ход, начатый до `F08-12b` (поля нет),
   * читается `[]`: его оценка мест не включала, он кончается на парах.
   */
  places: WorldPlaceCandidate[] | null;
  /** Этапа мест нет и почему; `null` - есть или выбор ещё не прошёл. */
  placesOff: WorldPlacesOffReason | null;
  /** Отсеянные шагом выбора герои, пары и места с причиной (`F08-8e`, `F08-12b`). */
  leftOut: WorldSkip[];
  /** Этапа пар нет и почему; `null` - есть или выбор ещё не прошёл. */
  pairsOff: WorldPairsOffReason | null;
  /**
   * Присутствие версии пересчитано перед новой парой и пересчёт сошёлся (уточнение Q1 `F08 | F08-8e-1`):
   * дальше новые пары читают сохранённое присутствие без пересчёта. Нет поля - пересчитывать.
   */
  mentionsRecounted: boolean;
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
  pairs: null,
  places: null,
  placesOff: null,
  leftOut: [],
  pairsOff: null,
  mentionsRecounted: false,
  steps: [],
  items: [],
  droppedQuotes: [],
  droppedSources: [],
  pending: null,
  stepsBroken: false,
});

/**
 * Шагов в ходе: выбор, по два на героя, по одному на пару и на место; до выбора - неизвестно (`null`).
 */
export const stepsTotalOf = (
  data: Pick<WorldWriteData, 'candidates' | 'pairs' | 'places'>,
): number | null =>
  data.candidates === null
    ? null
    : 1 + data.candidates.length * 2 + (data.pairs?.length ?? 0) + (data.places?.length ?? 0);

/** Шаг по номеру в этом ходе (`stepAt` с числом героев и пар хода). */
export const stepOfData = (data: Pick<WorldWriteData, 'candidates' | 'pairs'>, step: number) =>
  stepAt(step, data.candidates?.length ?? 0, data.pairs?.length ?? 0);

/**
 * Тип и роль сущности пункта (`F08-8e`): ключ кандидата пары - пара (по `pairs`, а не по виду ключа:
 * заведённые герои с `--` остались, `LEGACY-507`), иначе герой с ролью кандидата (`null` - не кандидат).
 */
export type WorldEntityKind =
  | { type: 'pair' }
  | { type: 'place' }
  | { type: 'character'; role: WorldCandidateRole | null };

export function entityKindOf(
  data: Pick<WorldWriteData, 'candidates' | 'pairs' | 'places'>,
  key: string,
): WorldEntityKind {
  if (data.pairs?.some((p) => p.key === key)) return { type: 'pair' };
  // Место (`F08-12b`): по `places`; ключ кандидата-героя местом не бывает - отсеян на выборе (Q1).
  if (data.places?.some((p) => p.key === key)) return { type: 'place' };
  return { type: 'character', role: data.candidates?.find((c) => c.key === key)?.role ?? null };
}

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

/**
 * Значение блока сущности (хранимый вид); у места блок `kind` - пара вида и номера Wikidata
 * (`WorldPlaceKindValue`, R3), как его несёт пункт хода.
 */
export const entityBlock = (entity: StoredWorldEntity, block: WorldBlock): unknown =>
  entity.type === 'place' && block === 'kind'
    ? ({
        kind: entity.kind ?? null,
        wikidataId: entity.wikidataId ?? null,
      } satisfies WorldPlaceKindValue)
    : (entity[block] ?? null);

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
    // Роли нет - ход до `F08-8b`, он брал только `main`; неизвестная роль - кандидат не читается.
    const role = c.role === undefined ? 'main' : oneOf(WORLD_CANDIDATE_ROLES, c.role);
    if (!role) return [];
    return [{ key, role, name, aliases: stringsOf(c.aliases), mentions: mentionsOf(c.mentions) }];
  });
}

function pairsOf(v: unknown): WorldPairCandidate[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((p) => {
    if (!isRecord(p)) return [];
    const key = stringOf(p.key);
    const a = stringOf(p.a);
    const b = stringOf(p.b);
    if (key === null || a === null || b === null) return [];
    const chapters = Array.isArray(p.chapters) ? p.chapters.flatMap((n) => intOf(n) ?? []) : [];
    return [{ key, a, b, linked: p.linked === true, chapters }];
  });
}

function placesOf(v: unknown): WorldPlaceCandidate[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((p) => {
    if (!isRecord(p)) return [];
    const key = stringOf(p.key);
    const name = stringOf(p.name);
    if (key === null || name === null) return [];
    return [{ key, name, aliases: stringsOf(p.aliases), mentions: mentionsOf(p.mentions) }];
  });
}

function leftOutOf(v: unknown): WorldSkip[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    if (!isRecord(d)) return [];
    const key = stringOf(d.key);
    const reason = oneOf(WORLD_SKIP_REASONS, d.reason);
    const names = Array.isArray(d.names) ? d.names.flatMap((n) => stringOf(n) ?? []) : [];
    return key !== null && reason ? [{ key, reason, names, chapters: intOf(d.chapters) }] : [];
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
    ...(stringOf(v.basis) !== null ? { basis: stringOf(v.basis) } : {}),
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
 * Данные хода из `ContentDraft.data`. Пункт или кандидат не той формы выпадает: номера пунктов в
 * ответе - индексы в `items`, кандидат шага - индекс в `candidates`, поэтому `stepsBroken` ставится
 * и тогда - ход не продолжается поверх битых данных.
 */
export function readWorldData(data: unknown): WorldWriteData {
  const d = isRecord(data) ? data : {};
  const rawSteps = Array.isArray(d.steps) ? d.steps : d.steps === undefined ? [] : null;
  const steps = (rawSteps ?? []).flatMap((s) => stepOf(s) ?? []);
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items = rawItems.flatMap((i) => itemOf(i) ?? []);
  const candidates = candidatesOf(d.candidates);
  const storedPairs = pairsOf(d.pairs);
  const storedPlaces = placesOf(d.places);
  // Шаг героя и пары берёт кандидата по индексу (`stepAt`): выпавшая запись сдвинула бы шаги на чужого.
  const candidatesBroken =
    (candidates !== null &&
      Array.isArray(d.candidates) &&
      candidates.length !== d.candidates.length) ||
    (storedPairs !== null && Array.isArray(d.pairs) && storedPairs.length !== d.pairs.length) ||
    (d.pairs !== undefined && d.pairs !== null && storedPairs === null) ||
    (storedPlaces !== null && Array.isArray(d.places) && storedPlaces.length !== d.places.length) ||
    (d.places !== undefined && d.places !== null && storedPlaces === null);
  const stepsBroken =
    rawSteps === null ||
    candidatesBroken ||
    steps.length !== rawSteps.length ||
    steps.some((s, i) => s.step !== i) ||
    items.length !== rawItems.length;
  return {
    candidates,
    // Ход до `F08-8e`: поля пар нет - пар нет (`[]`), а не «выбор не прошёл», и до выбора героев тоже
    // (Q2 `F08 | F08-8e-4`): новый ход пишет `pairs: null` явно (`emptyWorldData`, `worldDataJson`).
    pairs: storedPairs ?? (d.pairs === undefined ? [] : null),
    // Ход до `F08-12b`: поля мест нет - мест нет (`[]`), его шаги кончаются на парах.
    places: storedPlaces ?? (d.places === undefined ? [] : null),
    placesOff: oneOf(WORLD_PLACES_OFF_REASONS, d.placesOff),
    leftOut: leftOutOf(d.leftOut),
    pairsOff: oneOf(WORLD_PAIRS_OFF_REASONS, d.pairsOff),
    mentionsRecounted: d.mentionsRecounted === true,
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
    pairs: data.pairs,
    places: data.places,
    placesOff: data.placesOff,
    leftOut: data.leftOut,
    pairsOff: data.pairsOff,
    mentionsRecounted: data.mentionsRecounted,
    steps: data.steps,
    items: data.items,
    droppedQuotes: data.droppedQuotes,
    droppedSources: data.droppedSources,
    pending: data.pending,
  }) as unknown as Prisma.InputJsonValue;

/** Ключ оплаченного текста шага хода. */
export const stepKey = (step: number): string => `step:${step}`;
