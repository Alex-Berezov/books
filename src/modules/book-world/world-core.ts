import { isFilled } from '../book-analysis/book-analysis-core';
import { isRecord } from '../../shared/prisma/json-record.util';
import type { StoredWorldEntity } from './book-world-data';

/**
 * Ядро героя (`books-app-docs/features/F08-book-wiki/product.md` §3, `tech.md` §3): «Коротко»,
 * характер, путь «в начале → в конце», не меньше 3 цитат с главой, не меньше 2 сцен с главой,
 * посчитанное присутствие хотя бы в одной главе. Считает только бэкенд, одной функцией; фронт верит
 * `hasCore` из ответа. «Заполнено» — тот же предикат, что у анализа (`isFilled`): порога по длине нет.
 */
export const WORLD_CHARACTER_CORE = { quotes: 3, scenes: 2, mentionChapters: 1 } as const;

export type WorldCorePart = 'short' | 'character' | 'arc' | 'quotes' | 'scenes' | 'mentions';

export interface WorldCoreResult {
  hasCore: boolean;
  /** Чего не хватает до ядра — в `warnings` ответа записи и `editor.missing`. */
  missing: { part: WorldCorePart; have: number; need: number }[];
}

type CoreInput = Pick<StoredWorldEntity, 'short' | 'character' | 'arc' | 'quotes' | 'scenes'> & {
  /** Колонка `mentions` как есть (`{ chapters: number[] }`, пишет подсчёт `F08-2`). */
  mentions: unknown;
};

const hasChapter = (chapter: unknown) => typeof chapter === 'number' && chapter > 0;

/** Главы, где сущность найдена (`mentions.chapters`); не та форма — пусто. */
export function mentionChapters(mentions: unknown): number[] {
  if (!isRecord(mentions) || !Array.isArray(mentions.chapters)) return [];
  return mentions.chapters.filter((n): n is number => typeof n === 'number');
}

export function computeWorldCore(entity: CoreInput): WorldCoreResult {
  const quotes = (entity.quotes ?? []).filter(
    (q) => isFilled(q.text) && hasChapter(q.chapter),
  ).length;
  const scenes = (entity.scenes ?? []).filter(
    (s) => isFilled(s.text) && hasChapter(s.chapter),
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
