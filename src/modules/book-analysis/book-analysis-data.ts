import { Prisma } from '@prisma/client';
import { compactBlock } from '../author/author-page-data';
import { jsonField } from '../../shared/prisma/json-field.util';
import type {
  BookAnalysisAdaptationDto,
  BookAnalysisCharacterDto,
  BookAnalysisFactsDto,
  BookAnalysisFaqDto,
  BookAnalysisKeyQuoteDto,
  BookAnalysisMisreadingDto,
  BookAnalysisSourceDto,
  BookAnalysisStyleDto,
  BookAnalysisSymbolDto,
  BookAnalysisThemeDto,
  BookAnalysisTimelineEventDto,
} from './dto/book-analysis-blocks.dto';
import type { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';

/** Блоки анализа в том виде, в каком они лежат в базе (после `compactBlock`). `null` — блока нет. */
export interface StoredBookAnalysis {
  facts: BookAnalysisFactsDto | null;
  mainIdea: string | null;
  themes: BookAnalysisThemeDto[] | null;
  characters: BookAnalysisCharacterDto[] | null;
  symbols: BookAnalysisSymbolDto[] | null;
  keyQuotes: BookAnalysisKeyQuoteDto[] | null;
  titleMeaning: string | null;
  endingMeaning: string | null;
  context: string | null;
  timeline: BookAnalysisTimelineEventDto[] | null;
  style: BookAnalysisStyleDto[] | null;
  reception: string | null;
  adaptations: BookAnalysisAdaptationDto[] | null;
  misreadings: BookAnalysisMisreadingDto[] | null;
  discussionQuestions: string[] | null;
  faq: BookAnalysisFaqDto[] | null;
  sources: BookAnalysisSourceDto[] | null;
}

const TEXT_KEYS = ['mainIdea', 'titleMeaning', 'endingMeaning', 'context', 'reception'] as const;
const JSON_KEYS = [
  'facts',
  'themes',
  'characters',
  'symbols',
  'keyQuotes',
  'timeline',
  'style',
  'adaptations',
  'misreadings',
  'discussionQuestions',
  'faq',
  'sources',
] as const;

/** Все блоки §3 — и белый список ответа, и порядок слияния. */
export const BOOK_ANALYSIS_BLOCK_KEYS = [...TEXT_KEYS, ...JSON_KEYS] as const;

/**
 * Белый список выборки (`tech.md` §4): только блоки §3, признак ядра и даты. `id` и `bookVersionId`
 * наружу не идут — у ответа их нет. Литералом, а не из списка ключей: имя колонки сверяет `tsc`.
 */
export const BOOK_ANALYSIS_SELECT = {
  hasCore: true,
  createdAt: true,
  updatedAt: true,
  facts: true,
  mainIdea: true,
  themes: true,
  characters: true,
  symbols: true,
  keyQuotes: true,
  titleMeaning: true,
  endingMeaning: true,
  context: true,
  timeline: true,
  style: true,
  reception: true,
  adaptations: true,
  misreadings: true,
  discussionQuestions: true,
  faq: true,
  sources: true,
} as const satisfies Prisma.BookAnalysisSelect &
  Record<(typeof BOOK_ANALYSIS_BLOCK_KEYS)[number], true>;

export const EMPTY_BOOK_ANALYSIS: StoredBookAnalysis = Object.freeze(
  Object.fromEntries(BOOK_ANALYSIS_BLOCK_KEYS.map((k) => [k, null])),
) as unknown as StoredBookAnalysis;

/** Хранимые блоки из строки базы (JSON-колонки читаются как есть: форму стережёт запись). */
export function readStoredAnalysis(
  row: Partial<Record<keyof StoredBookAnalysis, unknown>>,
): StoredBookAnalysis {
  const out = { ...EMPTY_BOOK_ANALYSIS } as Record<keyof StoredBookAnalysis, unknown>;
  for (const key of TEXT_KEYS) out[key] = typeof row[key] === 'string' ? row[key] : null;
  for (const key of JSON_KEYS) out[key] = row[key] ?? null;
  return out as unknown as StoredBookAnalysis;
}

/**
 * Слияние T6: ключа в теле нет — блок прежний; пришёл `null`, `''` или `[]` — блок очищен;
 * пришёл список — он заменяет прежний целиком (элементы не сливаются).
 */
export function mergeAnalysis(
  existing: StoredBookAnalysis,
  dto: UpdateBookAnalysisDto,
): StoredBookAnalysis {
  const out = { ...existing } as Record<keyof StoredBookAnalysis, unknown>;
  for (const key of BOOK_ANALYSIS_BLOCK_KEYS) {
    const incoming = dto[key];
    if (incoming === undefined) continue;
    out[key] = compactBlock(incoming);
  }
  return out as unknown as StoredBookAnalysis;
}

/**
 * Блоки к записи в Prisma: `null` у Json-колонки — `DbNull` (`jsonField`). Поля
 * перечислены явно: имя колонки сверяет `tsc` со схемой.
 */
export function toAnalysisWrite(
  b: StoredBookAnalysis,
): Omit<Prisma.BookAnalysisUncheckedCreateInput, 'bookVersionId' | 'hasCore'> {
  return {
    mainIdea: b.mainIdea,
    titleMeaning: b.titleMeaning,
    endingMeaning: b.endingMeaning,
    context: b.context,
    reception: b.reception,
    ...jsonField('facts', b.facts),
    ...jsonField('themes', b.themes),
    ...jsonField('characters', b.characters),
    ...jsonField('symbols', b.symbols),
    ...jsonField('keyQuotes', b.keyQuotes),
    ...jsonField('timeline', b.timeline),
    ...jsonField('style', b.style),
    ...jsonField('adaptations', b.adaptations),
    ...jsonField('misreadings', b.misreadings),
    ...jsonField('discussionQuestions', b.discussionQuestions),
    ...jsonField('faq', b.faq),
    ...jsonField('sources', b.sources),
  };
}
