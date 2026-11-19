import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  findVerbatim,
  indexChapters,
  type IndexedParagraph,
} from '../translation/draft-quality/quote-check';
import type { StoredWorldEntity } from './book-world-data';

/**
 * Сверка пунктов сущности с главами версии — одно правило на запись (R4, R8: 400 с путём) и на
 * пересчёт присутствия (F08-2, решение арбитра `F08 | F08-2` Q2: несошедшийся пункт — `stale`).
 * Глава не из версии — у цитаты, сцены и этапа пути; цитата не стоит дословно (`findVerbatim`)
 * в абзаце своей главы — у цитаты.
 */
export interface WorldChapterIssue {
  /** Путь пункта без поля: `quotes.2`, `scenes.0`, `arc.stages.1`, `compare.3`. */
  item: string;
  /** Поле главы пункта: `chapter`; у строки сравнения пары — `chapterA` или `chapterB` (`F08-8c`). */
  field: string;
  /** Ключ пункта по содержанию (`worldItemKey`) — им пункт хранится в `mentions.stale`. */
  key: string;
  kind: 'chapter' | 'verbatim';
  chapter: number;
}

/** Ключ сверки цитаты: глава и текст. */
export const worldQuoteKey = (chapter: number, text: string) => `${chapter}\u0000${text}`;

type WorldItemKind = 'quotes' | 'scenes' | 'arc.stages' | 'compare';

/**
 * Ключ пункта с главой по содержанию (решение арбитра `F08 | F08-2` S1): вид, глава, заголовок,
 * текст. Им пункт помечается в `mentions.stale` — переживает удаление и перестановку соседних
 * пунктов, в отличие от номера. Единственное место, где ключ собирается.
 */
export function worldItemKey(
  kind: WorldItemKind,
  item: { chapter: number; title?: string | null; text?: string | null },
): string {
  // Разделитель — `\u001f`: `jsonb` не хранит `\u0000`, а ключи лежат в `mentions.stale`.
  return [kind, item.chapter, item.title ?? '', item.text ?? ''].join('\u001f');
}

type WorldChapterEntity = Pick<StoredWorldEntity, 'arc' | 'scenes' | 'quotes'> &
  Partial<Pick<StoredWorldEntity, 'compare'>>;

/**
 * Пункты сущности с главой — путь (для 400 и `editor.stale`), поле главы и ключ по содержанию.
 * Строка сравнения пары (`F08-8c`) даёт два пункта — по главе каждой стороны, с одним ключом:
 * не сошлась любая из двух глав — строка `stale` целиком.
 */
export function worldChapterItems(entity: WorldChapterEntity): {
  kind: WorldItemKind;
  path: string;
  field: string;
  key: string;
  chapter: number;
  text: string;
}[] {
  const items: ReturnType<typeof worldChapterItems> = [];
  const push = (
    kind: WorldItemKind,
    i: number,
    item: { chapter: number; title?: string | null; text?: string | null },
    field = 'chapter',
    key = worldItemKey(kind, item),
  ) => {
    if (typeof item.chapter !== 'number') return;
    items.push({
      kind,
      path: `${kind}.${i}`,
      field,
      key,
      chapter: item.chapter,
      text: item.text ?? '',
    });
  };
  (entity.arc?.stages ?? []).forEach((s, i) => push('arc.stages', i, s));
  (entity.scenes ?? []).forEach((s, i) => push('scenes', i, s));
  (entity.quotes ?? []).forEach((q, i) => push('quotes', i, q));
  (entity.compare ?? []).forEach((c, i) => {
    const key = worldCompareKey(c);
    push('compare', i, { chapter: c.chapterA, text: c.a }, 'chapterA', key);
    push('compare', i, { chapter: c.chapterB, text: c.b }, 'chapterB', key);
  });
  return items;
}

/** Ключ строки сравнения пары по содержанию: признак, обе стороны и обе главы (`F08-8c`). */
export function worldCompareKey(row: {
  feature?: string | null;
  a?: string | null;
  b?: string | null;
  chapterA: number;
  chapterB: number;
}): string {
  return worldItemKey('compare', {
    chapter: row.chapterA,
    title: row.feature,
    text: [row.a ?? '', row.chapterB, row.b ?? ''].join('\u001f'),
  });
}

/** Пути пунктов, чьи ключи в `stale`, — по текущим блокам сущности (`editor.stale`). */
export function stalePaths(entity: WorldChapterEntity, stale: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      worldChapterItems(entity)
        .filter((item) => stale.has(item.key))
        .map((item) => item.path),
    ),
  ].sort();
}

/** Абзацы главы для сверки цитат: текст `htmlToParagraphs`, индекс общий с ходом анализа. */
export function quoteParagraphs(chapterText: string): readonly IndexedParagraph[] {
  return indexChapters(new Map([[0, chapterText]])).get(0) ?? [];
}

export const quoteStandsIn = (text: string, paragraphs: readonly IndexedParagraph[]) =>
  findVerbatim(text, paragraphs) !== null;

/**
 * Пункты сущности, не сошедшиеся с главами: `known(n)` — глава есть в версии, `verbatim(n, text)` —
 * цитата стоит в ней дословно (спрашивается только у существующих глав).
 */
export function worldChapterIssues(
  entity: WorldChapterEntity,
  known: (chapter: number) => boolean,
  verbatim: (chapter: number, text: string) => boolean,
): WorldChapterIssue[] {
  const items = worldChapterItems(entity);
  const issues: WorldChapterIssue[] = items
    .filter((item) => !known(item.chapter))
    .map((item) => ({
      item: item.path,
      field: item.field,
      key: item.key,
      kind: 'chapter',
      chapter: item.chapter,
    }));
  for (const item of items) {
    if (item.kind === 'quotes' && known(item.chapter) && !verbatim(item.chapter, item.text)) {
      issues.push({
        item: item.path,
        field: item.field,
        key: item.key,
        kind: 'verbatim',
        chapter: item.chapter,
      });
    }
  }
  return issues;
}

/**
 * Отпечаток текста главы (`md5` базы) — только в чтениях этого файла: сверка «глава не менялась»
 * у записи (R4/R8) и у пересчёта сравнивает значения одного выражения.
 */
export type ChapterText = { number: number; content: string; digest: string };

/** Тексты названных глав с отпечатком — сверка цитат записи (`checkChapters`). */
export function chapterTexts(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bookVersionId: string,
  numbers: readonly number[],
): Promise<ChapterText[]> {
  return client.$queryRaw<ChapterText[]>`
    SELECT "number", "content", md5("content") AS "digest" FROM "Chapter"
    WHERE "bookVersionId" = ${bookVersionId} AND "number" = ANY(${[...numbers]}::int[])`;
}

/** Порция глав версии по номеру после `after` с отпечатком — подсчёт присутствия. */
export function chapterPage(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bookVersionId: string,
  after: number,
  limit: number,
): Promise<ChapterText[]> {
  return client.$queryRaw<ChapterText[]>`
    SELECT "number", "content", md5("content") AS "digest" FROM "Chapter"
    WHERE "bookVersionId" = ${bookVersionId} AND "number" > ${after}
    ORDER BY "number" ASC LIMIT ${limit}`;
}

/** Отпечатки текста названных глав (`md5`, без самого текста) — перепроверка записи под замком. */
export async function chapterDigests(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bookVersionId: string,
  numbers: readonly number[],
): Promise<Map<number, string>> {
  const rows = await client.$queryRaw<{ number: number; digest: string }[]>`
    SELECT "number", md5("content") AS "digest" FROM "Chapter"
    WHERE "bookVersionId" = ${bookVersionId} AND "number" = ANY(${[...numbers]}::int[])`;
  return new Map(rows.map((r) => [r.number, r.digest]));
}

/**
 * Отпечаток всего текста версии (решение арбитра `F08 | F08-2` R3b): `md5` строки
 * `номер:md5(текст)` по главам в порядке номера через запятую. Под замком читается одной строкой
 * базы (`versionFingerprint`), подсчёт собирает ту же строку из своих порций
 * (`fingerprintOfChapters`) — формат один, побайтово; номер ловит и перестановку глав.
 */
export function fingerprintOfChapters(
  chapters: readonly { number: number; digest: string }[],
): string {
  const line = chapters.map((c) => `${c.number}:${c.digest}`).join(',');
  return createHash('md5').update(line, 'utf8').digest('hex');
}

export async function versionFingerprint(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  bookVersionId: string,
): Promise<string> {
  const [row] = await client.$queryRaw<{ fingerprint: string }[]>`
    SELECT md5(coalesce(
      string_agg("number"::text || ':' || md5("content"), ',' ORDER BY "number"),
      ''
    )) AS "fingerprint"
    FROM "Chapter" WHERE "bookVersionId" = ${bookVersionId}`;
  return row.fingerprint;
}
