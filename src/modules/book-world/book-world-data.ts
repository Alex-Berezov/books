import { Prisma, WorldEntityType } from '@prisma/client';
import { compactBlock } from '../../shared/prisma/compact-block.util';
import { jsonField } from '../../shared/prisma/json-field.util';
import { isRecord } from '../../shared/prisma/json-record.util';
import { stableJson } from '../../shared/json/stable-json';
import { mentionChapters, mentionStale } from './world-core';
import { stalePaths, worldItemKey } from './world-quote-check';
import { publicMentionForms, type WorldChapterExclusion } from './world-mentions';
import type {
  BookAnalysisFaqDto,
  BookAnalysisRole,
  BookAnalysisSourceDto,
} from '../book-analysis/dto/book-analysis-blocks.dto';
import type {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
} from './dto/book-world-blocks.dto';
import type { BookWorldEntityInputDto } from './dto/update-book-world.dto';
import type {
  BookWorldEditorDto,
  BookWorldEntityDto,
  BookWorldEntitySummaryDto,
  BookWorldListEntityDto,
  BookWorldMentionsDto,
} from './dto/book-world-response.dto';

/** Поля страницы героя в колонке `blocks` (плоский JSON импорта, решение арбитра `F08 | F08-1` R7). */
export interface StoredWorldBlocks {
  profile: BookWorldProfileDto | null;
  appearance: string | null;
  character: string | null;
  arc: BookWorldArcDto | null;
  scenes: BookWorldSceneDto[] | null;
  relations: BookWorldRelationDto[] | null;
  quotes: BookWorldQuoteDto[] | null;
  critique: string | null;
  prototypes: string | null;
  adaptations: BookWorldAdaptationDto[] | null;
  faq: BookAnalysisFaqDto[] | null;
}

/** Сущность в том виде, в каком она пишется (после `compactBlock`). `null` — поля нет. */
export interface StoredWorldEntity extends StoredWorldBlocks {
  key: string;
  type: WorldEntityType;
  /** `null` только у новой сущности без имени или у очищенного имени — такую запись отбивает сервис. */
  name: string | null;
  role: BookAnalysisRole | null;
  aliases: string[] | null;
  /** «Коротко» — своей колонкой: её читает список сущностей без `blocks`. */
  short: string | null;
  sources: BookAnalysisSourceDto[] | null;
}

const TEXT_BLOCK_KEYS = ['appearance', 'character', 'critique', 'prototypes'] as const;
const JSON_BLOCK_KEYS = [
  'profile',
  'arc',
  'scenes',
  'relations',
  'quotes',
  'adaptations',
  'faq',
] as const;
export const BOOK_WORLD_BLOCK_KEYS = [...TEXT_BLOCK_KEYS, ...JSON_BLOCK_KEYS] as const;
/**
 * Содержательные поля сущности: их сливает импорт и по ним решается «текст изменился»
 * (решение арбитра R9). Ключ, тип и отметки (`isVisible`, `isIndexable`, `readAt`) сюда не входят.
 */
const CONTENT_KEYS = [
  'name',
  'role',
  'aliases',
  'short',
  'sources',
  ...BOOK_WORLD_BLOCK_KEYS,
] as const;

/**
 * Белый список строки списка читателя: поля сводки, без `blocks` и прочих Json-колонок
 * (список не тянет тексты страниц ради «Коротко»).
 */
export const WORLD_SUMMARY_SELECT = {
  key: true,
  type: true,
  name: true,
  role: true,
  short: true,
  hasCore: true,
  isIndexable: true,
  // «Впервые — глава N» карточки общей страницы (`product.md` §4 п.4) — колонкой, не из `mentions`.
  mentionFirst: true,
  updatedAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;

/**
 * Строка списка читателя: сводка плюс колонки форм имени — из них считаются `forms` (`F08-5`).
 * `aliasExclusions` читается только для отбора форм и наружу не отдаётся (`toReaderSummary`).
 */
export const WORLD_READER_SUMMARY_SELECT = {
  ...WORLD_SUMMARY_SELECT,
  aliases: true,
  aliasExclusions: true,
} as const satisfies Prisma.BookWorldEntitySelect;

/** Отметки редактора — `editor` ответа; читателю не выбираются вовсе. */
const WORLD_EDITOR_FIELDS = {
  isListed: true,
  isVisible: true,
  readAt: true,
  autoTextAt: true,
  firstPublishedAt: true,
  coreMissing: true,
  // Число глав присутствия в списке редактора (F08-2, `product.md` §17 п.2) — колонкой, не Json.
  mentionChapters: true,
} as const satisfies Prisma.BookWorldEntitySelect;

/** Строка списка редактора: сводка и отметки, тоже без `blocks`. */
export const WORLD_EDITOR_SUMMARY_SELECT = {
  ...WORLD_SUMMARY_SELECT,
  ...WORLD_EDITOR_FIELDS,
} as const satisfies Prisma.BookWorldEntitySelect;

/**
 * Белый список страницы сущности для читателя (`tech.md` §3): без `id`, `bookVersionId`,
 * `aliasExclusions`, `readAt`, `autoTextAt`, `mentionsAt` и отметок редактора.
 */
export const BOOK_WORLD_PUBLIC_SELECT = {
  ...WORLD_SUMMARY_SELECT,
  aliases: true,
  blocks: true,
  sources: true,
  mentions: true,
  createdAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;

/**
 * Страница сущности для редактора и выборка записи: читательская плюс отметки, исключения форм
 * имени и время подсчёта (`F08-2`) — их читает только редактор.
 */
export const BOOK_WORLD_SELECT = {
  ...BOOK_WORLD_PUBLIC_SELECT,
  ...WORLD_EDITOR_FIELDS,
  aliasExclusions: true,
  aliasChapterExclusions: true,
  mentionsAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;

export type WorldSummaryRow = Prisma.BookWorldEntityGetPayload<{
  select: typeof WORLD_SUMMARY_SELECT;
}>;
export type WorldReaderSummaryRow = Prisma.BookWorldEntityGetPayload<{
  select: typeof WORLD_READER_SUMMARY_SELECT;
}>;
export type WorldEditorSummaryRow = Prisma.BookWorldEntityGetPayload<{
  select: typeof WORLD_EDITOR_SUMMARY_SELECT;
}>;
export type WorldPublicRow = Prisma.BookWorldEntityGetPayload<{
  select: typeof BOOK_WORLD_PUBLIC_SELECT;
}>;
export type WorldEditorRow = Prisma.BookWorldEntityGetPayload<{ select: typeof BOOK_WORLD_SELECT }>;

const EMPTY_BLOCKS: StoredWorldBlocks = Object.freeze(
  Object.fromEntries(BOOK_WORLD_BLOCK_KEYS.map((k) => [k, null])),
) as unknown as StoredWorldBlocks;

/** Блоки из колонки `blocks` (JSON читается как есть: форму стережёт запись). */
export function readStoredBlocks(blocks: unknown): StoredWorldBlocks {
  const out = { ...EMPTY_BLOCKS } as Record<keyof StoredWorldBlocks, unknown>;
  if (!isRecord(blocks)) return out as unknown as StoredWorldBlocks;
  for (const key of TEXT_BLOCK_KEYS) {
    out[key] = typeof blocks[key] === 'string' ? blocks[key] : null;
  }
  for (const key of JSON_BLOCK_KEYS) out[key] = blocks[key] ?? null;
  return out as unknown as StoredWorldBlocks;
}

export function readStoredEntity(row: WorldPublicRow): StoredWorldEntity {
  return {
    key: row.key,
    type: row.type,
    name: row.name,
    role: (row.role as BookAnalysisRole | null) ?? null,
    aliases: readStringList(row.aliases),
    short: row.short,
    sources: (row.sources as BookAnalysisSourceDto[] | null) ?? null,
    ...readStoredBlocks(row.blocks),
  };
}

const numberList = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];

/** Ключи соседей из `mentions.coPresence` — единственный разбор этой формы хранения вне `readMentions`. */
export function coPresenceKeys(mentions: unknown): string[] {
  return isRecord(mentions) && isRecord(mentions.coPresence)
    ? Object.keys(mentions.coPresence)
    : [];
}

/**
 * Посчитанное присутствие наружу (`world-mentions.ts`): главы, первая глава, счёт по главам
 * и совместное присутствие; номера абзацев и `stale` из колонки не отдаются. `visibleKeys` —
 * читателю: в `coPresence` только соседи из этого набора (решение арбитра `F08 | F08-2` Q3).
 * Нет `chapters` — `null` (не посчитано).
 */
export function readMentions(
  mentions: unknown,
  visibleKeys?: ReadonlySet<string>,
): BookWorldMentionsDto | null {
  if (!isRecord(mentions) || !Array.isArray(mentions.chapters)) return null;
  const perChapter = isRecord(mentions.perChapter)
    ? Object.entries(mentions.perChapter)
        .flatMap(([n, count]) => (typeof count === 'number' ? [{ chapter: Number(n), count }] : []))
        .sort((a, b) => a.chapter - b.chapter)
    : [];
  const coPresence = isRecord(mentions.coPresence)
    ? Object.entries(mentions.coPresence)
        .filter(([key]) => !visibleKeys || visibleKeys.has(key))
        .map(([key, chapters]) => ({ key, chapters: numberList(chapters) }))
        .sort((a, b) => a.key.localeCompare(b.key))
    : [];
  return {
    chapters: mentionChapters(mentions),
    first: typeof mentions.first === 'number' ? mentions.first : null,
    perChapter,
    coPresence,
  };
}

/**
 * Вход подсчёта присутствия из строки (`F08-2`): формы имени, исключения и пункты с главами.
 * Одно чтение «строка → формы» на запись сущности и пересчёт версии.
 */
export function worldMentionSourceOf(row: WorldEditorRow) {
  const s = readStoredEntity(row);
  return {
    key: s.key,
    type: s.type,
    name: s.name,
    aliases: s.aliases,
    aliasExclusions: readAliasExclusions(row.aliasExclusions),
    aliasChapterExclusions: readAliasChapterExclusions(row.aliasChapterExclusions),
    quotes: s.quotes,
    scenes: s.scenes,
    arc: s.arc,
  };
}

/** Список строк из Json-колонки: только строки; не массив — `null`. */
function readStringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
}

/** Исключения форм имени из колонки (`F08-2`): только строки. */
export const readAliasExclusions = readStringList;

/**
 * Исключённые главы у формы из колонки (`F08-8a`): только записи со строкой `form` и хоть одной
 * целой главой (запись без глав карточка не сохранила бы обратно); не массив — `null`.
 */
export function readAliasChapterExclusions(value: unknown): WorldChapterExclusion[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((e: unknown) => {
    if (!isRecord(e) || typeof e.form !== 'string' || !Array.isArray(e.chapters)) return [];
    const chapters = e.chapters.filter((n): n is number => Number.isInteger(n));
    return chapters.length > 0 ? [{ form: e.form, chapters }] : [];
  });
}

/**
 * Слияние как `mergeAnalysis`: поля нет в теле — прежнее; `null`, `''` или `[]` — очищено; список
 * заменяет прежний целиком. Тип — из тела (в F08-1 он всегда `character`).
 */
export function mergeEntity(
  existing: StoredWorldEntity | null,
  input: BookWorldEntityInputDto,
): StoredWorldEntity {
  const base: StoredWorldEntity = existing ?? {
    key: input.key,
    type: input.type,
    name: null,
    role: null,
    aliases: null,
    short: null,
    sources: null,
    ...EMPTY_BLOCKS,
  };
  const out = { ...base, type: input.type } as Record<string, unknown>;
  for (const key of CONTENT_KEYS) {
    const incoming = input[key];
    if (incoming === undefined) continue;
    out[key] = compactBlock(incoming);
  }
  return out as unknown as StoredWorldEntity;
}

/**
 * Изменилось ли содержание после слияния (решение арбитра R9): новая сущность — да; иначе
 * сравниваются содержательные поля и тип в хранимом виде.
 */
export function worldContentChanged(
  existing: StoredWorldEntity | null,
  merged: StoredWorldEntity,
): boolean {
  if (!existing) return true;
  if (existing.type !== merged.type) return true;
  return CONTENT_KEYS.some((key) => stableJson(existing[key]) !== stableJson(merged[key]));
}

/** Колонки к записи: `null` у Json-колонки — `DbNull` (`jsonField`); блоки — одним объектом. */
export function toEntityWrite(e: StoredWorldEntity & { name: string }) {
  const blocks = compactBlock(
    Object.fromEntries(BOOK_WORLD_BLOCK_KEYS.map((key) => [key, e[key]])),
  );
  return {
    type: e.type,
    name: e.name,
    role: e.role,
    short: e.short,
    ...jsonField('aliases', e.aliases),
    ...jsonField('sources', e.sources),
    ...jsonField('blocks', blocks),
  } satisfies Omit<Prisma.BookWorldEntityUncheckedCreateInput, 'bookVersionId' | 'key'>;
}

export function toSummary(row: WorldSummaryRow): BookWorldEntitySummaryDto {
  return {
    key: row.key,
    type: row.type,
    name: row.name,
    role: (row.role as BookAnalysisRole | null) ?? null,
    short: row.short,
    hasCore: row.hasCore,
    isIndexable: row.isIndexable,
    mentionFirst: row.mentionFirst,
    updatedAt: row.updatedAt,
  };
}

/**
 * Строка списка читателя: сводка и формы имени для перелинковки (`F08-5`, решение арбитра
 * `F08 | F08-5` Q2) — исходным написанием, тем же отбором, что у подсчёта присутствия.
 */
export function toReaderSummary(row: WorldReaderSummaryRow): BookWorldListEntityDto {
  return {
    ...toSummary(row),
    forms: publicMentionForms({
      key: row.key,
      name: row.name,
      aliases: readStringList(row.aliases),
      aliasExclusions: readAliasExclusions(row.aliasExclusions),
    }),
  };
}

/**
 * Страница сущности. Читателю (`reader`) пункты из `mentions.stale` не отдаются — цитата, которой
 * больше нет дословно в тексте, и сцена или этап пути из удалённой главы (решение арбитра
 * `F08 | F08-2` Q2); в `coPresence` — только публичные соседи. Редактор видит всё и `editor.stale`.
 */
export function toEntityDto(
  row: WorldPublicRow,
  reader?: { visibleKeys: ReadonlySet<string> },
): BookWorldEntityDto {
  const s = readStoredEntity(row);
  if (reader) {
    const stale = mentionStale(row.mentions);
    const fresh =
      (kind: 'quotes' | 'scenes' | 'arc.stages') =>
      (item: { chapter: number; title?: string | null; text?: string | null }) =>
        !stale.has(worldItemKey(kind, item));
    s.quotes = s.quotes ? s.quotes.filter(fresh('quotes')) : null;
    s.scenes = s.scenes ? s.scenes.filter(fresh('scenes')) : null;
    if (s.arc?.stages) s.arc = { ...s.arc, stages: s.arc.stages.filter(fresh('arc.stages')) };
  }
  return {
    ...toSummary(row),
    aliases: s.aliases,
    profile: s.profile,
    appearance: s.appearance,
    character: s.character,
    arc: s.arc,
    scenes: s.scenes,
    relations: s.relations,
    quotes: s.quotes,
    critique: s.critique,
    prototypes: s.prototypes,
    adaptations: s.adaptations,
    faq: s.faq,
    sources: s.sources,
    mentions: readMentions(row.mentions, reader?.visibleKeys),
    createdAt: row.createdAt,
  };
}

/** Отметки редактора: только у выборок с `WORLD_EDITOR_FIELDS`, читателю не отдаются вовсе. */
export function editorOf(row: WorldEditorSummaryRow): BookWorldEditorDto {
  return {
    isListed: row.isListed,
    isVisible: row.isVisible,
    readAt: row.readAt,
    autoTextAt: row.autoTextAt,
    firstPublishedAt: row.firstPublishedAt,
    missing: row.coreMissing,
    mentionChapters: row.mentionChapters,
  };
}

/**
 * Отметки редактора на странице сущности: плюс исключения форм, несошедшиеся пункты, `mentionsAt`
 * и `recountPending` — у версии стоит строка очереди пересчёта (решение арбитра `F08 | F08-2` S5).
 */
export function entityEditorOf(row: WorldEditorRow, recountPending: boolean): BookWorldEditorDto {
  return {
    ...editorOf(row),
    aliasExclusions: readAliasExclusions(row.aliasExclusions),
    aliasChapterExclusions: readAliasChapterExclusions(row.aliasChapterExclusions),
    stale: stalePaths(readStoredEntity(row), mentionStale(row.mentions)),
    mentionsAt: row.mentionsAt,
    recountPending,
  };
}
