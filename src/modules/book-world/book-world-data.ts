import { createHash } from 'node:crypto';
import { Prisma, WorldEntityType } from '@prisma/client';
import { compactBlock } from '../../shared/prisma/compact-block.util';
import { jsonField } from '../../shared/prisma/json-field.util';
import { isRecord } from '../../shared/prisma/json-record.util';
import { stableJson } from '../../shared/json/stable-json';
import { mentionChapters, mentionStale } from './world-core';
import { stalePaths, worldCompareKey, worldItemKey } from './world-quote-check';
import { publicMentionForms, type WorldChapterExclusion } from './world-mentions';
import { currentGeo, geoInputOf, publicPoint, readGeo, type WorldGeoSubject } from './world-geo';
import type {
  BookAnalysisFaqDto,
  BookAnalysisRole,
  BookAnalysisSourceDto,
} from '../book-analysis/dto/book-analysis-blocks.dto';
import type {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldCompareDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
  WorldPlaceKind,
} from './dto/book-world-blocks.dto';
import { BOOK_WORLD_LIMITS, type BookWorldImportType } from './dto/book-world-blocks.dto';
import type { BookWorldEntityInputDto } from './dto/update-book-world.dto';
import type {
  BookWorldEditorDto,
  BookWorldEntityDto,
  BookWorldEntitySummaryDto,
  BookWorldListEntityDto,
  BookWorldMentionsDto,
  BookWorldPlaceCardDto,
  BookWorldTermCardDto,
} from './dto/book-world-response.dto';

/**
 * Поля страницы сущности в колонке `blocks` (плоский JSON импорта, решение арбитра `F08 | F08-1` R7):
 * героя, пары (`compare`, `bonds`, `differences`, `conclusion` — `F08-8c`), места (`kind`,
 * `location`, `significance`, `description`, `wikidataId` — `F08-12a`), предмета, понятия и события
 * (`characterKeys`, `themeKeys` — `F08-13a`). Чужие типу поля отбивает `checkWorldTypeFields`
 * (`world-refs.ts`).
 */
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
  compare: BookWorldCompareDto[] | null;
  bonds: string | null;
  differences: string | null;
  conclusion: string | null;
  kind: WorldPlaceKind | null;
  location: string | null;
  significance: string | null;
  description: string | null;
  wikidataId: string | null;
  /**
   * ТЗ на иллюстрацию героя `main`/`secondary` и места (`F08-12b` Q2) для редакции (решения `F08 | F08-11d` Q3–Q5): по-английски,
   * с названием книги и автором. Только редактору — читателю и в публичный DTO не идёт; вне сравнения
   * «текст изменился» (`NON_CONTENT_BLOCK_KEYS`, решение `F08 | F08-11d-2` R9).
   */
  imageBrief: string | null;
  /**
   * Отпечаток основы ТЗ — «Внешности» героя, «Описания» места (`briefBasisOf`, решение `F08 | F08-11d-2`):
   * служебный, из тела не берётся — его считает сервер; не совпал с текущей — ТЗ устарело.
   */
  imageBriefFor: string | null;
  faq: BookAnalysisFaqDto[] | null;
  /** Герои мира, с которыми связан предмет или событие (`F08-13a`, решение `F08 | F08-13` Q1). */
  characterKeys: string[] | null;
  /**
   * Темы анализа версии, с которыми связан предмет (`F08-13a`): на записи сверяются только новые
   * ключи из тела (`checkThemeKeys`, R1); читателю уходят только темы текущего публичного анализа.
   */
  themeKeys: string[] | null;
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

const TEXT_BLOCK_KEYS = [
  'appearance',
  'character',
  'critique',
  'prototypes',
  'bonds',
  'differences',
  'conclusion',
  'kind',
  'location',
  'significance',
  'description',
  'wikidataId',
  'imageBrief',
  'imageBriefFor',
] as const;
const JSON_BLOCK_KEYS = [
  'profile',
  'arc',
  'scenes',
  'relations',
  'quotes',
  'adaptations',
  'compare',
  'faq',
  'characterKeys',
  'themeKeys',
] as const;
export const BOOK_WORLD_BLOCK_KEYS = [...TEXT_BLOCK_KEYS, ...JSON_BLOCK_KEYS] as const;

/** Блоки пары героев (`F08-8c`) — у героя и места их нет (`checkWorldTypeFields`). */
export const WORLD_PAIR_BLOCK_KEYS = ['compare', 'bonds', 'differences', 'conclusion'] as const;
/** Свои блоки места (`F08-12a`, решение арбитра `F08 | F08-12` Q1) — у героя и пары их нет. */
export const WORLD_PLACE_BLOCK_KEYS = [
  'kind',
  'location',
  'significance',
  'description',
  'wikidataId',
] as const;
/** Блоки героя, пары и места: цитаты и частые вопросы. */
const WORLD_SHARED_BLOCK_KEYS: readonly string[] = ['quotes', 'faq'];
/**
 * Блоки страницы героя — у других типов их нет. Перечень явный (решение арбитра `F08 | F08-13` Q1):
 * при «всё прочее» новое поле любого типа молча становилось полем героя. Новое поле героя
 * добавляется сюда руками.
 */
export const WORLD_CHARACTER_BLOCK_KEYS = [
  'profile',
  'appearance',
  'character',
  'arc',
  'scenes',
  'relations',
  'critique',
  'prototypes',
  'adaptations',
  'imageBrief',
  'imageBriefFor',
] as const satisfies readonly (typeof BOOK_WORLD_BLOCK_KEYS)[number][];

/**
 * Блоки предмета, понятия и события (`F08-13a`, решение арбитра `F08 | F08-13` Q1): «Коротко» —
 * колонкой, как у всех; ТЗ на иллюстрацию у них нет (Q4) — `imageBrief` поле чужого типа.
 */
export const WORLD_OBJECT_BLOCK_KEYS = [
  'significance',
  'description',
  'quotes',
  'faq',
  'characterKeys',
  'themeKeys',
] as const;
export const WORLD_TERM_BLOCK_KEYS = ['significance', 'quotes'] as const;
export const WORLD_EVENT_BLOCK_KEYS = [
  'significance',
  'scenes',
  'quotes',
  'characterKeys',
] as const;

/** Блоки, которые сущность типа может нести (`checkWorldTypeFields`): свои и общие. */
export const WORLD_BLOCKS_OF_TYPE: Readonly<Record<BookWorldImportType, ReadonlySet<string>>> = {
  character: new Set([...WORLD_CHARACTER_BLOCK_KEYS, ...WORLD_SHARED_BLOCK_KEYS]),
  pair: new Set([...WORLD_PAIR_BLOCK_KEYS, ...WORLD_SHARED_BLOCK_KEYS]),
  // У места есть сцены (`product.md` §7: «что здесь происходит — сцены с главами»).
  // У места есть ТЗ на иллюстрацию 16:9 по «Описанию» (решение `F08 | F08-12b` Q2).
  place: new Set([
    ...WORLD_PLACE_BLOCK_KEYS,
    'scenes',
    'imageBrief',
    'imageBriefFor',
    ...WORLD_SHARED_BLOCK_KEYS,
  ]),
  object: new Set(WORLD_OBJECT_BLOCK_KEYS),
  term: new Set(WORLD_TERM_BLOCK_KEYS),
  event: new Set(WORLD_EVENT_BLOCK_KEYS),
};
/** Тип несёт блок (`WORLD_BLOCKS_OF_TYPE`): одно правило «у какого типа какое поле» для сервиса. */
export const worldTypeHasBlock = (type: string, block: string): boolean =>
  WORLD_BLOCKS_OF_TYPE[type as BookWorldImportType]?.has(block) === true;

/**
 * Поля сущности, которые сливает и пишет импорт (`mergeEntity`, `toEntityWrite`). Ключ, тип и отметки
 * (`isVisible`, `isIndexable`, `readAt`) сюда не входят. «Текст изменился» (решение арбитра R9)
 * решается по ним же за вычетом `NON_CONTENT_BLOCK_KEYS`.
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
 * Служебные блоки: пишутся и сливаются, но страницу с сайта не снимают — их правка не ставит
 * `autoTextAt` (решение арбитра `F08 | F08-11d-2` R9).
 */
const NON_CONTENT_BLOCK_KEYS: readonly (typeof CONTENT_KEYS)[number][] = [
  'imageBrief',
  'imageBriefFor',
];
const CHANGE_KEYS = CONTENT_KEYS.filter((key) => !NON_CONTENT_BLOCK_KEYS.includes(key));

/**
 * Отпечаток «Внешности» для ТЗ на иллюстрацию (решение `F08 | F08-11d-2`): «Внешности» нет — `null`.
 * Один на ход, импорт и проверку устаревания: ТЗ, написанное по другой «Внешности», — устаревшее.
 */
export function appearancePrint(appearance: string | null | undefined): string | null {
  if (typeof appearance !== 'string' || appearance.trim() === '') return null;
  return createHash('sha256').update(stableJson(appearance.trim())).digest('hex').slice(0, 16);
}

/**
 * Блок основы ТЗ на иллюстрацию: у героя — «Внешность», у места — «Описание» (решение `F08 | F08-12b` Q2:
 * «ТЗ на место — вид по описанию в тексте»). Одно правило на ход, импорт и проверку устаревания.
 */
export const briefBasisBlock = (type: string): 'appearance' | 'description' =>
  type === 'place' ? 'description' : 'appearance';

/** Текст основы ТЗ сущности по её типу (`briefBasisBlock`). */
export const briefBasisOf = (
  type: string,
  e: Partial<Pick<StoredWorldBlocks, 'appearance' | 'description'>>,
): string | null => e[briefBasisBlock(type)] ?? null;

/**
 * ТЗ устарело: написано не по текущей основе (`briefBasisOf`) или без отпечатка (решения
 * `F08 | F08-11d-2`, `F08 | F08-12b` Q2).
 */
export function imageBriefStale(
  type: string,
  e: Pick<StoredWorldBlocks, 'appearance' | 'description' | 'imageBrief' | 'imageBriefFor'>,
): boolean {
  if (!e.imageBrief) return false;
  return e.imageBriefFor === null || e.imageBriefFor !== appearancePrint(briefBasisOf(type, e));
}

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
  // Точка места (`F08-12a`): читателю из колонки уходит только проверенная точка (`publicPoint`).
  geo: true,
  createdAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;

/**
 * Карточка места общей страницы `/wiki` (решение арбитра `F08 | F08-12` Q4): что нужно условию
 * показа (`worldCardShown`), тексту списка мест со сценами и точке карты. Наружу — только
 * `toPlaceCard`, белым списком.
 */
export const WORLD_PLACE_CARD_SELECT = {
  key: true,
  type: true,
  name: true,
  short: true,
  // Формы имени — вход отпечатка проверки точки (`publicPoint`): точка только для текущих названий.
  aliases: true,
  isListed: true,
  isVisible: true,
  readAt: true,
  autoTextAt: true,
  blocks: true,
  mentions: true,
  geo: true,
} as const satisfies Prisma.BookWorldEntitySelect;
export type WorldPlaceCardRow = Prisma.BookWorldEntityGetPayload<{
  select: typeof WORLD_PLACE_CARD_SELECT;
}>;

/**
 * Что нужно строке глоссария (`F08-13a`, решения арбитра `F08 | F08-13` Q6, Q7): условию показа
 * (`worldCardShown`) и строке «термин — определение — глава». Наружу — только `toTermCard`.
 */
export const WORLD_TERM_CARD_SELECT = {
  key: true,
  type: true,
  name: true,
  short: true,
  mentionFirst: true,
  isListed: true,
  isVisible: true,
  readAt: true,
  autoTextAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;
export type WorldTermCardRow = Prisma.BookWorldEntityGetPayload<{
  select: typeof WORLD_TERM_CARD_SELECT;
}>;

/** Строка глоссария белым списком: термин, определение («Коротко»), первая глава, своя страница. */
export function toTermCard(row: WorldTermCardRow): BookWorldTermCardDto {
  return {
    key: row.key,
    name: row.name,
    short: row.short,
    chapter: row.mentionFirst,
    hasPage: row.isListed,
  };
}

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
  const blocks = readStoredBlocks(row.blocks);
  return {
    key: row.key,
    type: row.type,
    name: row.name,
    role: (row.role as BookAnalysisRole | null) ?? null,
    aliases: readStringList(row.aliases),
    short: row.short,
    sources: (row.sources as BookAnalysisSourceDto[] | null) ?? null,
    ...blocks,
    scenes: withoutParagraph(blocks.scenes),
  };
}

/**
 * Сцены без `paragraph`: номер абзаца не хранится, его считает выдача (`sceneParagraph`). Снимается
 * и с хранимого (записи до `F08-10a`), и с входа - иначе карточка, сохранённая с номером из GET,
 * или сдвиг абзаца пересчётом считались бы правкой текста и снимали страницу с сайта (R9,
 * решение арбитра `F08 | F08-10a` Q1: «input ignored»).
 */
function withoutParagraph(
  scenes: readonly BookWorldSceneDto[] | null | undefined,
): BookWorldSceneDto[] | null {
  // Колонка читается как есть: не массив или не объект в списке - прежнее значение, без падения.
  if (!Array.isArray(scenes)) return (scenes as BookWorldSceneDto[] | null | undefined) ?? null;
  return scenes.map((scene: unknown) => {
    if (!isRecord(scene)) return scene as BookWorldSceneDto;
    const rest = Object.fromEntries(Object.entries(scene).filter(([key]) => key !== 'paragraph'));
    return rest as unknown as BookWorldSceneDto;
  });
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
 * Главы, где сущность вместе с `other` (`mentions.coPresence[other]`), по возрастанию; нет — `[]`.
 * Одно правило общих глав пары (`F08-8c`, Q6): условие заведения (`pairEvidenceOf`) и присутствие
 * пары (`pairMentions`).
 */
export function coPresenceWith(mentions: unknown, other: string): number[] {
  const chapters =
    isRecord(mentions) && isRecord(mentions.coPresence) ? mentions.coPresence[other] : undefined;
  return numberList(chapters).sort((x, y) => x - y);
}

/**
 * Абзац сцены в главе `chapter` (с 1): первый абзац с формой имени по свежему подсчёту
 * `mentions.paragraphs` (индексы `paragraphsOf(htmlToParagraphs)` с 0). Считается при чтении, а не
 * хранится: пересчёт после правки главы сдвигает его сам, старые миры получают его без записи
 * (решения арбитра `F08 | F08-10` Q2-Q3, `F08 | F08-10a` Q1). Нет главы или абзацев - `null`.
 */
export function sceneParagraph(mentions: unknown, chapter: number): number | null {
  const at =
    isRecord(mentions) && isRecord(mentions.paragraphs)
      ? numberList(mentions.paragraphs[String(chapter)]).filter(
          (n) => Number.isInteger(n) && n >= 0,
        )
      : [];
  // Номер сверх предела входа DTO - `null`: GET -> PUT карточки не должен давать 400.
  const first = at.length > 0 ? Math.min(...at) + 1 : null;
  return first !== null && first <= BOOK_WORLD_LIMITS.paragraph ? first : null;
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
    compare: s.compare,
  };
}

/** Список строк из Json-колонки: только строки; не массив — `null`. */
export function readStringList(value: unknown): string[] | null {
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
    out[key] = compactBlock(key === 'scenes' ? withoutParagraph(input.scenes) : incoming);
  }
  // Отпечаток ТЗ (решение `F08 | F08-11d-2`): пишется вместе с ТЗ — от хода (по «Внешности» ответа),
  // иначе по «Внешности» после слияния; ТЗ в теле нет — прежний; ТЗ очищено — нет и отпечатка.
  // То же ТЗ ещё раз (повторный импорт) отпечаток не трогает: иначе устаревшее ТЗ стало бы свежим.
  const briefSame = stableJson(out.imageBrief) === stableJson(base.imageBrief);
  if (input.imageBrief !== undefined && !(briefSame && input.imageBriefFor === undefined)) {
    out.imageBriefFor = out.imageBrief
      ? (input.imageBriefFor ??
        appearancePrint(briefBasisOf(input.type, out as unknown as StoredWorldBlocks)))
      : null;
  }
  return out as unknown as StoredWorldEntity;
}

/**
 * Изменилось ли содержание после слияния (решение арбитра R9): новая сущность — да; иначе
 * сравниваются содержательные поля (без `NON_CONTENT_BLOCK_KEYS`) и тип в хранимом виде.
 */
export function worldContentChanged(
  existing: StoredWorldEntity | null,
  merged: StoredWorldEntity,
): boolean {
  return differsBy(CHANGE_KEYS, existing, merged);
}

/**
 * Изменилась ли запись после слияния — нужна ли запись вообще: как `worldContentChanged`, но и по
 * служебным блокам (`NON_CONTENT_BLOCK_KEYS`) — правка одного `imageBrief` пишется, `autoTextAt` не ставит.
 */
export function worldEntityEdited(
  existing: StoredWorldEntity | null,
  merged: StoredWorldEntity,
): boolean {
  return differsBy(CONTENT_KEYS, existing, merged);
}

function differsBy(
  keys: readonly (typeof CONTENT_KEYS)[number][],
  existing: StoredWorldEntity | null,
  merged: StoredWorldEntity,
): boolean {
  if (!existing) return true;
  if (existing.type !== merged.type) return true;
  return keys.some((key) => stableJson(existing[key]) !== stableJson(merged[key]));
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
    // У пары нет своих форм имени (решение арбитра `F08 | F08-8c` Q6): «A и B» не цель перелинковки.
    forms:
      row.type === 'pair'
        ? []
        : publicMentionForms({
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
  reader?: { visibleKeys: ReadonlySet<string>; themeKeys?: ReadonlySet<string> },
): BookWorldEntityDto {
  const s = readStoredEntity(row);
  if (reader) {
    const stale = mentionStale(row.mentions);
    const fresh =
      (kind: 'quotes' | 'scenes' | 'arc.stages') =>
      (item: { chapter: number; title?: string | null; text?: string | null }) =>
        !stale.has(worldItemKey(kind, item));
    s.quotes = s.quotes ? s.quotes.filter(fresh('quotes')) : null;
    s.scenes = freshScenes(s.scenes, row.mentions);
    if (s.arc?.stages) s.arc = { ...s.arc, stages: s.arc.stages.filter(fresh('arc.stages')) };
    s.compare = s.compare ? s.compare.filter((c) => !stale.has(worldCompareKey(c))) : null;
    // Герои предмета и события — только публичные (`visibleKeys`, как соседи `coPresence`).
    if (Array.isArray(s.characterKeys)) {
      s.characterKeys = s.characterKeys.filter((k) => reader.visibleKeys.has(k));
    }
    // Темы предмета — только темы текущего анализа (решение `F08 | F08-13a` R1); редактор видит все.
    const themes = reader.themeKeys;
    if (themes && Array.isArray(s.themeKeys))
      s.themeKeys = s.themeKeys.filter((k) => themes.has(k));
  }
  s.scenes = withSceneParagraph(s.scenes, row.mentions);
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
    compare: s.compare,
    bonds: s.bonds,
    differences: s.differences,
    conclusion: s.conclusion,
    kind: s.kind,
    location: s.location,
    significance: s.significance,
    description: s.description,
    wikidataId: s.wikidataId,
    faq: s.faq,
    characterKeys: s.characterKeys,
    themeKeys: s.themeKeys,
    sources: s.sources,
    mentions: readMentions(row.mentions, reader?.visibleKeys),
    point: publicPoint(readGeo(row.geo), geoSubjectOf(row)),
    createdAt: row.createdAt,
  };
}

/** Сцены без пунктов `mentions.stale` — что видит читатель (решение арбитра `F08 | F08-2` Q2). */
function freshScenes(
  scenes: BookWorldSceneDto[] | null,
  mentions: unknown,
): BookWorldSceneDto[] | null {
  if (!Array.isArray(scenes)) return scenes;
  const stale = mentionStale(mentions);
  return scenes.filter((scene) => !stale.has(worldItemKey('scenes', scene)));
}

/**
 * Абзац сцены из свежего подсчёта (`sceneParagraph`): сохранённый `paragraph` не берётся. Мусор
 * в колонке (не массив, не объект в списке) отдаётся как лежит - без 500 у редактора.
 */
function withSceneParagraph(
  scenes: BookWorldSceneDto[] | null,
  mentions: unknown,
): BookWorldSceneDto[] | null {
  if (!Array.isArray(scenes)) return scenes;
  return scenes.map((scene: unknown) =>
    isRecord(scene)
      ? ({
          ...scene,
          paragraph: sceneParagraph(mentions, Number(scene.chapter)),
        } as BookWorldSceneDto)
      : (scene as BookWorldSceneDto),
  );
}

/**
 * Карточка места (Q4): название, «Коротко», реальное или вымышленное, где находится, есть ли своя
 * страница (`isListed`), проверенная точка и сцены белым списком `title`, `chapter`, `paragraph` —
 * без текста сцены и без пунктов `mentions.stale`. Абзац сцены — из свежего подсчёта.
 */
export function toPlaceCard(row: WorldPlaceCardRow): BookWorldPlaceCardDto {
  const blocks = readStoredBlocks(row.blocks);
  // Сцены — тем же правилом, что страница сущности читателю (`freshScenes`, `withSceneParagraph`);
  // в карточку — только сцены с заголовком и главой, белым списком полей.
  const readerScenes = withSceneParagraph(
    freshScenes(withoutParagraph(blocks.scenes), row.mentions),
    row.mentions,
  );
  const scenes = (readerScenes ?? []).flatMap((scene: unknown) =>
    isRecord(scene) && typeof scene.title === 'string' && Number.isInteger(scene.chapter)
      ? [
          {
            title: scene.title,
            chapter: scene.chapter as number,
            paragraph: (scene.paragraph as number | null) ?? null,
          },
        ]
      : [],
  );
  return {
    key: row.key,
    name: row.name,
    short: row.short,
    kind: blocks.kind,
    location: blocks.location,
    hasPage: row.isListed,
    point: publicPoint(readGeo(row.geo), geoSubjectOf(row)),
    scenes,
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
  const blocks = readStoredBlocks(row.blocks);
  return {
    ...editorOf(row),
    aliasExclusions: readAliasExclusions(row.aliasExclusions),
    aliasChapterExclusions: readAliasChapterExclusions(row.aliasChapterExclusions),
    stale: stalePaths(readStoredEntity(row), mentionStale(row.mentions)),
    mentionsAt: row.mentionsAt,
    recountPending,
    imageBrief: blocks.imageBrief,
    imageBriefStale: imageBriefStale(row.type, blocks),
    geo: geoCheckOf(row),
  };
}

/**
 * Вход проверки точки из строки — одна сборка на писателя (`WorldGeoService`), страницу и карточку
 * (`publicPoint`): отпечатки записи и выдачи считаются от одних и тех же полей.
 */
export function geoSubjectOf(row: {
  type: string;
  name: string | null;
  aliases: unknown;
  blocks: unknown;
}): WorldGeoSubject {
  const blocks = readStoredBlocks(row.blocks);
  return {
    type: row.type,
    kind: blocks.kind,
    wikidataId: blocks.wikidataId,
    name: row.name,
    aliases: readStringList(row.aliases),
  };
}

/**
 * Итог проверки точки места редактору — тем же правилом, что точка читателю (`publicPoint`):
 * итог для прежнего номера или названий не выдаётся за текущий. Реальное место с номером, для
 * которого проверки нет (Wikidata не ответила или проверка ещё не прошла), — `unavailable` без
 * даты: проверится при следующей записи. Не место, вымышленное или без номера — `null`.
 */
function geoCheckOf(row: WorldEditorRow): BookWorldEditorDto['geo'] {
  const subject = geoSubjectOf(row);
  // Подлежит ли проверке — правилом писателя (`geoInputOf`; язык здесь не нужен, только условие).
  const input = geoInputOf(subject, '');
  if (!input) return null;
  const geo = currentGeo(readGeo(row.geo), subject);
  return geo
    ? { wikidataId: geo.wikidataId, checkedAt: geo.checkedAt, reason: geo.reason }
    : { wikidataId: input.wikidataId, checkedAt: null, reason: 'unavailable' };
}
