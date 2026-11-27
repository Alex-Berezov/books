import { Prisma } from '@prisma/client';
import { isRecord } from '../../shared/prisma/json-record.util';
import { htmlToParagraphs } from '../translation/content-draft/content-draft.text';
import { coPresenceWith, type StoredWorldEntity } from './book-world-data';
import { pairMembers } from './world-refs';
import { WorldMentionCounter, type WorldMentionSource, type WorldMentions } from './world-mentions';
import {
  chapterPage,
  fingerprintOfChapters,
  quoteParagraphs,
  quoteStandsIn,
  worldChapterIssues,
  worldQuoteKey,
} from './world-quote-check';

/** Глав с текстом в одной выборке подсчёта: в памяти одна порция текстов, а не вся книга. */
export const WORLD_MENTIONS_CHAPTERS_BATCH = 20;

/** Сущность для подсчёта: формы имени и пункты с главами (сверка `stale`). */
export type WorldCountSource = WorldMentionSource &
  Pick<StoredWorldEntity, 'type' | 'quotes' | 'scenes' | 'arc'> &
  Partial<Pick<StoredWorldEntity, 'compare'>>;

/** Колонка `mentions`: подсчёт плюс несошедшиеся пункты (решение арбитра `F08 | F08-2` Q2). */
export interface StoredWorldMentions extends WorldMentions {
  stale: string[];
}

export interface WorldCountResult {
  byKey: Map<string, StoredWorldMentions>;
  /** Отпечаток текста версии на момент подсчёта (`fingerprintOfChapters`) — сверка под замком. */
  fingerprint: string;
}

/**
 * Подсчёт по всем главам версии (`tech.md` §4): главы читаются порциями по номеру, тексты не
 * держатся, текст главы разбирается один раз на подсчёт и на сверку цитат. Сверка пунктов
 * с главами — правило записи (`worldChapterIssues`, Q2): несошедшийся пункт идёт в `stale`.
 * `coPresence` — между героями (`character`) набора.
 */
export async function countWorldMentions(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bookVersionId: string,
  entities: readonly WorldCountSource[],
): Promise<WorldCountResult> {
  const characters = new Set(entities.filter((e) => e.type === 'character').map((e) => e.key));
  // Пара в тексте не ищется (решение арбитра `F08 | F08-8c` Q6): её главы — общие главы героев.
  const counter = new WorldMentionCounter(
    entities.filter((e) => e.type !== 'pair'),
    characters,
  );
  const quotesByChapter = new Map<number, string[]>();
  for (const q of entities.flatMap((e) => e.quotes ?? [])) {
    const list = quotesByChapter.get(q.chapter);
    if (list) list.push(q.text);
    else quotesByChapter.set(q.chapter, [q.text]);
  }
  const verbatim = new Map<string, boolean>();
  const digests = new Map<number, string>();

  for (let after = -1; ; ) {
    const rows = await chapterPage(client, bookVersionId, after, WORLD_MENTIONS_CHAPTERS_BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      digests.set(row.number, row.digest);
      const text = htmlToParagraphs(row.content);
      counter.addChapterText(row.number, text);
      const quotes = quotesByChapter.get(row.number);
      if (quotes) {
        const paragraphs = quoteParagraphs(text);
        for (const q of quotes) {
          verbatim.set(worldQuoteKey(row.number, q), quoteStandsIn(q, paragraphs));
        }
      }
      // Подсчёт главы — синхронная работа (на 100 сущностях по 31 форме — около 13 мс на главу
      // в 12 тыс. знаков, замер в деле F08-2): между главами цикл событий отпускается.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    after = rows[rows.length - 1].number;
    if (rows.length < WORLD_MENTIONS_CHAPTERS_BATCH) break;
  }

  const counted = counter.result();
  const byKey = new Map<string, StoredWorldMentions>();
  for (const e of entities) {
    const stale = worldChapterIssues(
      e,
      (n) => digests.has(n),
      (n, text) => verbatim.get(worldQuoteKey(n, text)) === true,
    ).map((issue) => issue.key);
    const own =
      e.type === 'pair'
        ? pairMentions(e.key, counted)
        : eventMentions(e, counted.get(e.key)!, (n) => digests.has(n));
    byKey.set(e.key, { ...own, stale: [...new Set(stale)].sort() });
  }
  return {
    byKey,
    fingerprint: fingerprintOfChapters(
      [...digests].map(([number, digest]) => ({ number, digest })),
    ),
  };
}

/**
 * Главы события (`F08-13a`, решения арбитра `F08 | F08-13` Q1, `F08 | F08-13a` R2): название эпизода
 * («Сон Обломова») в тексте почти не встречается, и одно случайное совпадение формы не должно стирать
 * главы сцен, проверенные редактором, — главы события = главы форм ∪ главы его сцен, которые есть
 * в версии; `first` — наименьшая. Счёт по главам и абзацы — только по формам (у сцены их нет).
 * Единственное место правила: ядро, публичность и выдача читают `mentions`. Не событие — как есть.
 */
export function eventMentions(
  e: Pick<WorldCountSource, 'type' | 'scenes'>,
  own: WorldMentions,
  inVersion: (chapter: number) => boolean,
): WorldMentions {
  if (e.type !== 'event') return own;
  const fromScenes = eventSceneChapters(e.scenes).filter(inVersion);
  const chapters = [...new Set([...own.chapters, ...fromScenes])].sort((a, b) => a - b);
  return { ...own, chapters, first: chapters[0] ?? null };
}

/**
 * Главы сцен события — вход его глав (`eventMentions`) и условие пересчёта при записи (решение
 * `F08 | F08-13a` R3): целые номера без повторов по возрастанию. Колонка читается как есть: не массив
 * или не номер — не глава.
 */
export function eventSceneChapters(scenes: unknown): number[] {
  if (!Array.isArray(scenes)) return [];
  const chapters = scenes.flatMap((s: unknown) => {
    const n = isRecord(s) ? s.chapter : undefined;
    return typeof n === 'number' && Number.isInteger(n) ? [n] : [];
  });
  return [...new Set(chapters)].sort((a, b) => a - b);
}

/**
 * Присутствие пары (Q6): главы, где оба героя ключа, — `coPresence` первого со вторым; абзацы
 * по этим главам — объединение абзацев обоих героев (абзац сцены пары, решения арбитра
 * `F08 | F08-10` Q3, `F08 | F08-10a` Q1); счёта по главам и соседей у пары нет. Героя нет
 * в подсчёте — глав нет.
 */
export function pairMentions(
  key: string,
  counted: ReadonlyMap<string, WorldMentions>,
): WorldMentions {
  const members = pairMembers(key);
  const chapters = members ? coPresenceWith(counted.get(members[0]), members[1]) : [];
  const paragraphs: Record<string, number[]> = {};
  for (const n of chapters) {
    const at = new Set(
      (members ?? ([] as string[])).flatMap((m) => counted.get(m)?.paragraphs[String(n)] ?? []),
    );
    if (at.size > 0) paragraphs[String(n)] = [...at].sort((a, b) => a - b);
  }
  return { chapters, first: chapters[0] ?? null, perChapter: {}, paragraphs, coPresence: {} };
}
