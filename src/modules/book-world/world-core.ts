import { isFilled } from '../book-analysis/book-analysis-core';
import { isRecord } from '../../shared/prisma/json-record.util';
import type { StoredWorldEntity } from './book-world-data';
import { worldCompareKey, worldItemKey } from './world-quote-check';

/**
 * Ядро героя (`books-app-docs/features/F08-book-wiki/product.md` §3, `tech.md` §3): «Коротко»,
 * характер, путь «в начале → в конце», не меньше 3 цитат с главой, не меньше 2 сцен с главой,
 * посчитанное присутствие хотя бы в одной главе. Считает только бэкенд, одной функцией; фронт верит
 * `hasCore` из ответа. «Заполнено» — тот же предикат, что у анализа (`isFilled`): порога по длине нет.
 */
export const WORLD_CHARACTER_CORE = { quotes: 3, scenes: 2, mentionChapters: 1 } as const;

/**
 * Ядро пары героев (`F08-8c`, решение арбитра `F08 | F08-8c` Q2): «Коротко», не меньше 4 строк
 * сравнения с обеими сторонами и главами, общие главы героев хотя бы одна (`mentions` пары —
 * пересечение глав членов, Q6), вывод.
 */
export const WORLD_PAIR_CORE = { compare: 4, mentionChapters: 1 } as const;

/**
 * Ядро места (`F08-12a`, решение арбитра `F08 | F08-12` Q1): «Коротко», реальное или вымышленное,
 * значение в книге, не меньше 2 сцен с главой (`product.md` §2), посчитанное присутствие хотя бы
 * в одной главе. Цитата в ядро не входит (`product.md` §3: «цитата или упоминания»).
 */
export const WORLD_PLACE_CORE = { scenes: 2, mentionChapters: 1 } as const;

export type WorldCorePart =
  | 'short'
  | 'character'
  | 'arc'
  | 'quotes'
  | 'scenes'
  | 'mentions'
  | 'compare'
  | 'conclusion'
  | 'kind'
  | 'significance';

export interface WorldCoreResult {
  hasCore: boolean;
  /** Чего не хватает до ядра — в `warnings` ответа записи и `editor.missing`. */
  missing: { part: WorldCorePart; have: number; need: number }[];
}

type CoreInput = Pick<StoredWorldEntity, 'short' | 'character' | 'arc' | 'quotes' | 'scenes'> &
  Partial<Pick<StoredWorldEntity, 'compare' | 'conclusion' | 'kind' | 'significance'>> & {
    /** Тип сущности; нет — герой (вход без типа — только герой, до `F08-8c`). */
    type?: StoredWorldEntity['type'];
    /** Колонка `mentions` как есть (`WorldMentions` подсчёта `F08-2`, `world-mentions.ts`). */
    mentions: unknown;
  };

const hasChapter = (chapter: unknown) => typeof chapter === 'number' && chapter > 0;

/** Главы, где сущность найдена (`mentions.chapters`); не та форма — пусто. */
export function mentionChapters(mentions: unknown): number[] {
  if (!isRecord(mentions) || !Array.isArray(mentions.chapters)) return [];
  return mentions.chapters.filter((n): n is number => typeof n === 'number');
}

/**
 * Пункты, не сошедшиеся с текстом версии на последнем пересчёте (`mentions.stale`, решение арбитра
 * `F08 | F08-2` Q2): цитата не стоит дословно в своей главе или главы нет, сцена или этап пути —
 * главы нет. Хранятся ключами по содержанию (`worldItemKey`, S1). В ядро не идут, читателю не
 * отдаются.
 */
export function mentionStale(mentions: unknown): Set<string> {
  if (!isRecord(mentions) || !Array.isArray(mentions.stale)) return new Set();
  return new Set(mentions.stale.filter((p): p is string => typeof p === 'string'));
}

export function computeWorldCore(entity: CoreInput): WorldCoreResult {
  if (entity.type === 'pair') return computePairCore(entity);
  if (entity.type === 'place') return computePlaceCore(entity);
  const stale = mentionStale(entity.mentions);
  const quotes = (entity.quotes ?? []).filter(
    (q) => isFilled(q.text) && hasChapter(q.chapter) && !stale.has(worldItemKey('quotes', q)),
  ).length;
  const scenes = (entity.scenes ?? []).filter(
    (s) => isFilled(s.text) && hasChapter(s.chapter) && !stale.has(worldItemKey('scenes', s)),
  ).length;
  const chapters = mentionChapters(entity.mentions).length;

  const missing: WorldCoreResult['missing'] = [];
  if (!isFilled(entity.short)) missing.push({ part: 'short', have: 0, need: 1 });
  if (!isFilled(entity.character)) missing.push({ part: 'character', have: 0, need: 1 });
  if (!(isFilled(entity.arc?.from) && isFilled(entity.arc?.to))) {
    missing.push({ part: 'arc', have: 0, need: 1 });
  }
  if (quotes < WORLD_CHARACTER_CORE.quotes) {
    missing.push({ part: 'quotes', have: quotes, need: WORLD_CHARACTER_CORE.quotes });
  }
  if (scenes < WORLD_CHARACTER_CORE.scenes) {
    missing.push({ part: 'scenes', have: scenes, need: WORLD_CHARACTER_CORE.scenes });
  }
  if (chapters < WORLD_CHARACTER_CORE.mentionChapters) {
    missing.push({
      part: 'mentions',
      have: chapters,
      need: WORLD_CHARACTER_CORE.mentionChapters,
    });
  }
  return { hasCore: missing.length === 0, missing };
}

function computePairCore(entity: CoreInput): WorldCoreResult {
  const stale = mentionStale(entity.mentions);
  const compare = (entity.compare ?? []).filter(
    (c) =>
      isFilled(c.feature) &&
      isFilled(c.a) &&
      isFilled(c.b) &&
      hasChapter(c.chapterA) &&
      hasChapter(c.chapterB) &&
      !stale.has(worldCompareKey(c)),
  ).length;
  const chapters = mentionChapters(entity.mentions).length;

  const missing: WorldCoreResult['missing'] = [];
  if (!isFilled(entity.short)) missing.push({ part: 'short', have: 0, need: 1 });
  if (compare < WORLD_PAIR_CORE.compare) {
    missing.push({ part: 'compare', have: compare, need: WORLD_PAIR_CORE.compare });
  }
  if (chapters < WORLD_PAIR_CORE.mentionChapters) {
    missing.push({ part: 'mentions', have: chapters, need: WORLD_PAIR_CORE.mentionChapters });
  }
  if (!isFilled(entity.conclusion)) missing.push({ part: 'conclusion', have: 0, need: 1 });
  return { hasCore: missing.length === 0, missing };
}

function computePlaceCore(entity: CoreInput): WorldCoreResult {
  const stale = mentionStale(entity.mentions);
  const scenes = (entity.scenes ?? []).filter(
    (s) => isFilled(s.text) && hasChapter(s.chapter) && !stale.has(worldItemKey('scenes', s)),
  ).length;
  const chapters = mentionChapters(entity.mentions).length;

  const missing: WorldCoreResult['missing'] = [];
  if (!isFilled(entity.short)) missing.push({ part: 'short', have: 0, need: 1 });
  if (!isFilled(entity.kind)) missing.push({ part: 'kind', have: 0, need: 1 });
  if (!isFilled(entity.significance)) missing.push({ part: 'significance', have: 0, need: 1 });
  if (scenes < WORLD_PLACE_CORE.scenes) {
    missing.push({ part: 'scenes', have: scenes, need: WORLD_PLACE_CORE.scenes });
  }
  if (chapters < WORLD_PLACE_CORE.mentionChapters) {
    missing.push({ part: 'mentions', have: chapters, need: WORLD_PLACE_CORE.mentionChapters });
  }
  return { hasCore: missing.length === 0, missing };
}
