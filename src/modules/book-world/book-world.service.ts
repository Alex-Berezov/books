import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PublicationStatus } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { loadChapterNumbers } from '../../shared/chapters/chapter-numbers';
import {
  assertExpectedRowShape,
  assertRowAsExpected,
  recordChanged,
  type ExpectedRow,
} from '../../shared/dto/expected-row.util';
import { isRecord } from '../../shared/prisma/json-record.util';
import { stableJson } from '../../shared/json/stable-json';
import { codedConflict } from '../../shared/errors/coded-conflict';
import { readableVersion, writableVersionLanguage } from '../../common/roles/readable-version';
import { AUTO_TEXT_NONE } from '../translation/content-draft/content-draft.constants';
import { htmlToParagraphs } from '../translation/content-draft/content-draft.text';
import { findVerbatim, indexChapters } from '../translation/draft-quality/quote-check';
import { lockVersionRow } from '../translation/version-lock';
import {
  BOOK_WORLD_PUBLIC_SELECT,
  BOOK_WORLD_SELECT,
  WORLD_EDITOR_SUMMARY_SELECT,
  WORLD_SUMMARY_SELECT,
  editorOf,
  mergeEntity,
  readStoredBlocks,
  readStoredEntity,
  toEntityDto,
  toEntityWrite,
  toSummary,
  worldContentChanged,
  type StoredWorldEntity,
  type WorldEditorRow,
  type WorldEditorSummaryRow,
} from './book-world-data';
import { BOOK_WORLD_TX_OPTIONS, lockBookWorld } from './book-world-lock';
import { BOOK_WORLD_KEY_REGEX, BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import type { MarkWorldReadDto } from './dto/mark-world-read.dto';
import type { SetWorldFlagsDto } from './dto/set-world-flags.dto';
import type {
  BookWorldEntityResponseDto,
  BookWorldEntitySaveResponseDto,
  BookWorldEntitySummaryDto,
  BookWorldListResponseDto,
  BookWorldSaveResponseDto,
  BookWorldWarningDto,
} from './dto/book-world-response.dto';
import type {
  BookWorldEntityInputDto,
  UpdateBookWorldDto,
  UpdateBookWorldEntityDto,
} from './dto/update-book-world.dto';
import { computeWorldCore, type WorldCoreResult } from './world-core';
import { WORLD_ENTITY_PUBLIC_WHERE, isWorldEntityPublic, worldListedWrite } from './world-public';
import {
  checkWorldRefs,
  collectWorldChapterRefs,
  duplicateWorldKeys,
  worldEntityRefs,
  type WorldRefError,
} from './world-refs';

/** 409: сущность была на сайте — удаляется только снятием «показывать» (`tech.md` §2, R2). */
export const WORLD_ENTITY_PUBLISHED = 'WORLD_ENTITY_PUBLISHED';
/** 409: на сущность ссылаются другие сущности версии (`worldEntityRefs`). */
export const WORLD_ENTITY_REFERENCED = 'WORLD_ENTITY_REFERENCED';
/** 409 «прочитано»: показанный вкладке `autoTextAt` уже не последний текст модели (R5). */
export const WORLD_TEXT_CHANGED = 'WORLD_TEXT_CHANGED';

type Actor = { userId: string; email: string } | undefined;
type VersionState = { status: PublicationStatus };

/** Сущность тела после слияния и проверок — то, что запишется (или записалось бы при `dryRun`). */
interface PlannedEntity {
  existing: WorldEditorRow | null;
  merged: StoredWorldEntity & { name: string };
  /** Содержание изменилось после слияния — импорт ставит `autoTextAt` (решение арбитра R9). */
  changed: boolean;
  core: WorldCoreResult;
  warnings: BookWorldWarningDto[];
}

/**
 * Что уже проверено о главах версии: есть ли номер и стоит ли цитата дословно. Заполняется
 * проверкой до транзакции; в транзакции запрашивается только то, чего здесь нет (слияние
 * под замком принесло чужую цитату или главу).
 */
interface ChapterCheck {
  known: Map<number, boolean>;
  verbatim: Map<string, boolean>;
  /**
   * Отпечаток текста прочитанной главы (`md5` базы). У `Chapter` нет `updatedAt`, поэтому правку
   * главы между проверкой и записью видно по отпечатку (`revalidateChapters`).
   */
  digest: Map<number, string>;
}

/** Глав с текстом в одной выборке сверки цитат (`checkChapters`). */
export const WORLD_QUOTE_CHAPTERS_BATCH = 20;

const newChapterCheck = (): ChapterCheck => ({
  known: new Map(),
  verbatim: new Map(),
  digest: new Map(),
});
const quoteKey = (chapter: number, text: string) => `${chapter}\u0000${text}`;
const notFoundEntity = () => new NotFoundException('World entity not found');

/**
 * Мир книги версии (F08-1, `books-app-docs/features/F08-book-wiki/tech.md` §2-§3; решения арбитра
 * `F08 | F08-1`). Записи — под замком мира версии и замком строки версии (публикация ставит
 * `firstPublishedAt` под тем же замком строки), каждая пересчитывает ядро и `isListed`.
 */
@Injectable()
export class BookWorldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderatorRoles: ModeratorRolesService,
  ) {}

  /** Список: читателю — только публичные сущности, редактору — все с отметками; без `blocks`. */
  async getList(bookVersionId: string, actor: Actor): Promise<BookWorldListResponseDto> {
    const { language, editor } = await readableVersion(
      this.prisma,
      this.moderatorRoles,
      bookVersionId,
      actor,
    );
    if (editor) {
      const rows = await this.prisma.bookWorldEntity.findMany({
        where: { bookVersionId },
        select: WORLD_EDITOR_SUMMARY_SELECT,
        orderBy: { key: 'asc' },
        take: BOOK_WORLD_LIMITS.entities,
      });
      return { language, entities: rows.map(withEditor) };
    }
    const rows = await this.prisma.bookWorldEntity.findMany({
      where: { bookVersionId, ...WORLD_ENTITY_PUBLIC_WHERE },
      select: WORLD_SUMMARY_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    return { language, entities: rows.map(toSummary) };
  }

  /** Страница сущности: непубличная не редактору — 404, как и черновик версии. */
  async getEntity(
    bookVersionId: string,
    key: string,
    actor: Actor,
  ): Promise<BookWorldEntityResponseDto> {
    if (!BOOK_WORLD_KEY_REGEX.test(key)) throw notFoundEntity();
    const { language, editor } = await readableVersion(
      this.prisma,
      this.moderatorRoles,
      bookVersionId,
      actor,
    );
    const where = { bookVersionId_key: { bookVersionId, key } };
    const [entity, chapterNumbers] = await Promise.all([
      editor
        ? this.prisma.bookWorldEntity
            .findUnique({ where, select: BOOK_WORLD_SELECT })
            .then((row) => (row ? { ...toEntityDto(row), editor: editorOf(row) } : null))
        : this.prisma.bookWorldEntity
            .findFirst({
              where: { bookVersionId, key, ...WORLD_ENTITY_PUBLIC_WHERE },
              select: BOOK_WORLD_PUBLIC_SELECT,
            })
            .then((row) => (row ? toEntityDto(row) : null)),
      loadChapterNumbers(this.prisma, bookVersionId),
    ]);
    if (!entity) throw notFoundEntity();
    return { language, chapterNumbers, entity };
  }

  /**
   * Импорт версии: слияние по ключу; сущности вне тела не трогаются. Сверка `expected` — по всей
   * версии (R6): наибольший `updatedAt` её сущностей или «сущностей нет». Главы и дословность
   * цитат проверяются до транзакции, вне замков; `dryRun` целиком вне замков и без записи.
   */
  async saveVersion(
    bookVersionId: string,
    dto: UpdateBookWorldDto,
    dryRun: boolean,
    expected: ExpectedRow & { expectedCount?: number } = {},
  ): Promise<BookWorldSaveResponseDto> {
    if (!dryRun) {
      assertExpectedRowShape(expected);
      if (expected.expectedAbsent && expected.expectedCount !== undefined) {
        throw new BadRequestException('expectedAbsent and expectedCount are mutually exclusive');
      }
    }
    const language = await writableVersionLanguage(this.prisma, bookVersionId, dto.language);
    throwIfErrors(duplicateWorldKeys(dto.entities));
    const prefix = (i: number) => `entities.${i}.`;
    const chapters = newChapterCheck();
    const checked = await this.plan(this.prisma, bookVersionId, dto.entities, prefix, chapters);
    if (dryRun) return { world: null, entities: checked.map(savedSummary) };

    const { planned, rows } = await this.inWorldTx(bookVersionId, async (tx, version) => {
      const latest = await tx.bookWorldEntity.findFirst({
        where: { bookVersionId },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      });
      const message = 'The world of this version was changed by another editor';
      assertWorldAsExpected(latest, expected, message);
      if (
        expected.expectedCount !== undefined &&
        (await tx.bookWorldEntity.count({ where: { bookVersionId } })) !== expected.expectedCount
      ) {
        throw recordChanged(message);
      }
      await revalidateChapters(tx, bookVersionId, chapters);
      const result = await this.plan(tx, bookVersionId, dto.entities, prefix, chapters);
      const now = new Date();
      for (const p of result) await writePlanned(tx, bookVersionId, p, version, now);
      // Список ответа — под тем же замком после записи: чужая запись не вклинится между ними.
      const world = await tx.bookWorldEntity.findMany({
        where: { bookVersionId },
        select: WORLD_EDITOR_SUMMARY_SELECT,
        orderBy: { key: 'asc' },
        take: BOOK_WORLD_LIMITS.entities,
      });
      return { planned: result, rows: world };
    });
    return {
      world: { language, entities: rows.map(withEditor) },
      entities: planned.map(savedSummary),
    };
  }

  /** Импорт одной сущности; ключ тела, если есть, равен адресу. Сверка `expected` — по сущности. */
  async saveEntity(
    bookVersionId: string,
    key: string,
    dto: UpdateBookWorldEntityDto,
    dryRun: boolean,
    expected: ExpectedRow = {},
  ): Promise<BookWorldEntitySaveResponseDto> {
    if (!BOOK_WORLD_KEY_REGEX.test(key)) throw notFoundEntity();
    if (dto.key !== undefined && dto.key !== key) {
      throw new BadRequestException([`key: "${dto.key}" in the body is not "${key}" in the path`]);
    }
    if (!dryRun) assertExpectedRowShape(expected);
    await writableVersionLanguage(this.prisma, bookVersionId, dto.language);
    // `language` тела слиянию не мешает: `mergeEntity` читает только поля сущности.
    const input: BookWorldEntityInputDto = { ...dto, key };
    const prefix = () => '';
    const chapters = newChapterCheck();
    const [checked] = await this.plan(this.prisma, bookVersionId, [input], prefix, chapters);
    if (dryRun) return { entity: null, hasCore: checked.core.hasCore, warnings: checked.warnings };

    const { row, planned } = await this.inWorldTx(bookVersionId, async (tx, version) => {
      const current = await tx.bookWorldEntity.findUnique({
        where: { bookVersionId_key: { bookVersionId, key } },
        select: { updatedAt: true },
      });
      assertWorldAsExpected(current, expected, 'The entity was changed by another editor');
      await revalidateChapters(tx, bookVersionId, chapters);
      const [p] = await this.plan(tx, bookVersionId, [input], prefix, chapters);
      return { row: await writePlanned(tx, bookVersionId, p, version, new Date()), planned: p };
    });
    return {
      entity: { ...toEntityDto(row), editor: editorOf(row) },
      hasCore: planned.core.hasCore,
      warnings: planned.warnings,
    };
  }

  /**
   * Жёсткое удаление (решение арбитра PM-5): была на сайте или публична сейчас — 409
   * `WORLD_ENTITY_PUBLISHED` (скрывается снятием «показывать»); на неё ссылаются — 409
   * `WORLD_ENTITY_REFERENCED`.
   */
  async remove(bookVersionId: string, key: string): Promise<void> {
    if (!BOOK_WORLD_KEY_REGEX.test(key)) throw notFoundEntity();
    await this.inWorldTx(bookVersionId, async (tx, version) => {
      const entity = await tx.bookWorldEntity.findUnique({
        where: { bookVersionId_key: { bookVersionId, key } },
        select: { isListed: true, firstPublishedAt: true },
      });
      if (!entity) throw notFoundEntity();
      if (entity.firstPublishedAt || isWorldEntityPublic(entity, version)) {
        throw codedConflict(
          WORLD_ENTITY_PUBLISHED,
          'The entity has been on the site: hide it (isVisible=false) instead of deleting',
        );
      }
      const [others, analysis] = await Promise.all([
        tx.bookWorldEntity.findMany({
          where: { bookVersionId, key: { not: key } },
          select: { key: true, blocks: true },
          orderBy: { key: 'asc' },
          take: BOOK_WORLD_LIMITS.entities,
        }),
        tx.bookAnalysis.findUnique({ where: { bookVersionId }, select: { characters: true } }),
      ]);
      // Ссылка на ключ, который есть и у героя анализа, после удаления остаётся действительной
      // (`checkWorldRefs` принимает ключи анализа) — удалению она не мешает.
      const stillResolves = analysisCharacterKeys(analysis?.characters).has(key);
      const referencedBy = (stillResolves ? [] : others)
        .filter((o) => worldEntityRefs(readStoredBlocks(o.blocks)).some((r) => r.key === key))
        .map((o) => o.key);
      if (referencedBy.length > 0) {
        throw codedConflict(
          WORLD_ENTITY_REFERENCED,
          `Other entities refer to "${key}": ${referencedBy.join(', ')}`,
          { referencedBy },
        );
      }
      await tx.bookWorldEntity.delete({ where: { bookVersionId_key: { bookVersionId, key } } });
    });
  }

  /**
   * «Прочитано» (решение арбитра R5, только `admin`): текста модели нет — 409 `AUTO_TEXT_NONE`;
   * показанный вкладке `autoTextAt` не последний — 409 `WORLD_TEXT_CHANGED`. Ядро не проверяется.
   */
  async markRead(
    bookVersionId: string,
    key: string,
    dto: MarkWorldReadDto,
  ): Promise<BookWorldEntitySummaryDto> {
    if (!BOOK_WORLD_KEY_REGEX.test(key)) throw notFoundEntity();
    const row = await this.inWorldTx(bookVersionId, async (tx, version) => {
      const entity = await findEntity(tx, bookVersionId, key);
      if (!entity.autoTextAt) {
        throw codedConflict(AUTO_TEXT_NONE, 'No model text has been written here');
      }
      if (
        dto.autoTextAt === null ||
        entity.autoTextAt.getTime() !== new Date(dto.autoTextAt).getTime()
      ) {
        throw codedConflict(
          WORLD_TEXT_CHANGED,
          'New model text was written after the tab was shown: read it first',
          { current: { autoTextAt: entity.autoTextAt } },
        );
      }
      // Не раньше последнего текста модели: часы другого экземпляра могли уйти вперёд (как `T184`).
      const readAt = new Date(Math.max(Date.now(), entity.autoTextAt.getTime()));
      return updateState(tx, bookVersionId, entity, { readAt }, version);
    });
    return withEditor(row);
  }

  /** «Показывать» и «индексировать»; хотя бы одна отметка в теле. Текст не меняют (R9). */
  async setFlags(
    bookVersionId: string,
    key: string,
    dto: SetWorldFlagsDto,
  ): Promise<BookWorldEntitySummaryDto> {
    if (!BOOK_WORLD_KEY_REGEX.test(key)) throw notFoundEntity();
    if (dto.isVisible === undefined && dto.isIndexable === undefined) {
      throw new BadRequestException(['isVisible or isIndexable is required']);
    }
    const patch = {
      ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
      ...(dto.isIndexable !== undefined ? { isIndexable: dto.isIndexable } : {}),
    };
    const row = await this.inWorldTx(bookVersionId, async (tx, version) =>
      updateState(tx, bookVersionId, await findEntity(tx, bookVersionId, key), patch, version),
    );
    return withEditor(row);
  }

  /**
   * Транзакция записи. Порядок замков один: замок мира версии, затем строка версии
   * (`lockVersionRow`), затем строки сущностей. Публикация берёт строку версии, затем строки
   * сущностей (`stampWorldFirstPublished`); «прочитано» T184 — только строку версии. Замка мира
   * никто не берёт после строки версии, строк сущностей никто не держит до неё — цикла нет.
   * Публикация ждёт записи мира; `firstPublishedAt` ставит либо запись (версия уже опубликована),
   * либо публикация (видит закоммиченный `isListed`). Версию удалили — 404.
   */
  private async inWorldTx<T>(
    bookVersionId: string,
    fn: (tx: Prisma.TransactionClient, version: VersionState) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBookWorld(tx, bookVersionId);
        await lockVersionRow(tx, bookVersionId);
        const version = await tx.bookVersion.findUnique({
          where: { id: bookVersionId },
          select: { status: true },
        });
        if (!version) throw new NotFoundException('BookVersion not found');
        return fn(tx, version);
      }, BOOK_WORLD_TX_OPTIONS);
    } catch (e: unknown) {
      // Каскадное удаление версии между чтением и записью: FK-отказ на create (P2003) или снятая
      // строка на update (P2025) — это 404, как у анализа.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2003' || e.code === 'P2025')
      ) {
        throw new NotFoundException('BookVersion not found');
      }
      throw e;
    }
  }

  /**
   * Слияние и проверки сущностей тела — на слитом наборе версии: имя (R7), ссылки, предел
   * сущностей версии, главы версии (R4) и дословность цитат в своей главе (R8). Ошибки — одним 400
   * с путями полей; затем ядро и предупреждения `core_incomplete`. Главы — через `chapters`:
   * второй вызов (в транзакции) читает только то, чего не видел первый.
   */
  private async plan(
    client: Prisma.TransactionClient,
    bookVersionId: string,
    inputs: readonly BookWorldEntityInputDto[],
    prefix: (i: number) => string,
    chapters: ChapterCheck,
  ): Promise<PlannedEntity[]> {
    const [existingRows, versionKeys, analysis] = await Promise.all([
      client.bookWorldEntity.findMany({
        where: { bookVersionId, key: { in: inputs.map((i) => i.key) } },
        select: BOOK_WORLD_SELECT,
      }),
      client.bookWorldEntity.findMany({
        where: { bookVersionId },
        select: { key: true },
        orderBy: { key: 'asc' },
        take: BOOK_WORLD_LIMITS.entities,
      }),
      client.bookAnalysis.findUnique({ where: { bookVersionId }, select: { characters: true } }),
    ]);
    const byKey = new Map(existingRows.map((r) => [r.key, r]));
    const entityKeys = new Set([...versionKeys.map((r) => r.key), ...inputs.map((i) => i.key)]);
    const errors: WorldRefError[] = [];
    if (entityKeys.size > BOOK_WORLD_LIMITS.entities) {
      errors.push({
        path: 'entities',
        message: `the version would hold ${entityKeys.size} entities, at most ${BOOK_WORLD_LIMITS.entities}`,
      });
    }
    const ctx = { entityKeys, analysisKeys: analysisCharacterKeys(analysis?.characters) };

    const merged = inputs.map((input, i) => {
      const row = byKey.get(input.key) ?? null;
      const stored = row ? readStoredEntity(row) : null;
      const entity = mergeEntity(stored, input);
      if (entity.name === null) {
        errors.push({
          path: `${prefix(i)}name`,
          message: row ? 'name cannot be cleared' : 'name is required for a new entity',
        });
      }
      for (const e of checkWorldRefs(entity, ctx)) {
        errors.push({ path: `${prefix(i)}${e.path}`, message: e.message });
      }
      return { row, stored, entity };
    });
    errors.push(
      ...(await checkChapters(
        client,
        bookVersionId,
        merged.map((m) => m.entity),
        prefix,
        chapters,
      )),
    );
    throwIfErrors(errors);

    return merged.map(({ row, stored, entity }, i) => {
      const core = computeWorldCore({ ...entity, mentions: row?.mentions ?? null });
      return {
        existing: row,
        merged: entity as StoredWorldEntity & { name: string },
        changed: worldContentChanged(stored, entity),
        core,
        warnings: core.missing.map((m) => ({
          code: 'core_incomplete' as const,
          path: `${prefix(i)}${m.part}`,
          message: coreMessage(m),
        })),
      };
    });
  }
}

/**
 * Главы сущностей (R4, R8): номер не из версии — 400 с путём; цитата не найдена дословно
 * (`findVerbatim`, нормализация общая с ходом анализа) в абзаце своей главы — 400
 * `…quotes.M.text`. Текст читается только у глав, на которые ссылаются ещё не проверенные цитаты.
 */
async function checkChapters(
  client: Prisma.TransactionClient,
  bookVersionId: string,
  entities: readonly StoredWorldEntity[],
  prefix: (i: number) => string,
  cache: ChapterCheck,
): Promise<WorldRefError[]> {
  const refs = entities.map((e) => collectWorldChapterRefs(e));
  const unseen = [...new Set(refs.flat().map((r) => r.chapter))].filter((n) => !cache.known.has(n));
  if (unseen.length > 0) {
    const found = new Set(
      (
        await client.chapter.findMany({
          where: { bookVersionId, number: { in: unseen } },
          select: { number: true },
        })
      ).map((c) => c.number),
    );
    for (const n of unseen) cache.known.set(n, found.has(n));
  }

  const pending = entities
    .flatMap((e) => e.quotes ?? [])
    .filter((q) => cache.known.get(q.chapter) && !cache.verbatim.has(quoteKey(q.chapter, q.text)));
  // Тексты глав — порциями: в памяти одна порция глав и её индекс абзацев, а не все главы,
  // на которые ссылаются цитаты версии (до `quotes` × `entities` глав).
  const pendingChapters = [...new Set(pending.map((q) => q.chapter))].sort((a, b) => a - b);
  for (let at = 0; at < pendingChapters.length; at += WORLD_QUOTE_CHAPTERS_BATCH) {
    const batch = new Set(pendingChapters.slice(at, at + WORLD_QUOTE_CHAPTERS_BATCH));
    const texts = await client.$queryRaw<{ number: number; content: string; digest: string }[]>`
      SELECT "number", "content", md5("content") AS "digest" FROM "Chapter"
      WHERE "bookVersionId" = ${bookVersionId} AND "number" = ANY(${[...batch]}::int[])`;
    for (const c of texts) cache.digest.set(c.number, c.digest);
    const index = indexChapters(new Map(texts.map((c) => [c.number, htmlToParagraphs(c.content)])));
    for (const q of pending) {
      if (!batch.has(q.chapter)) continue;
      cache.verbatim.set(
        quoteKey(q.chapter, q.text),
        findVerbatim(q.text, index.get(q.chapter) ?? []) !== null,
      );
    }
  }

  const errors: WorldRefError[] = [];
  entities.forEach((entity, i) => {
    for (const ref of refs[i]) {
      if (!cache.known.get(ref.chapter)) {
        errors.push({
          path: `${prefix(i)}${ref.path}`,
          message: `chapter ${ref.chapter} is not in this version`,
        });
      }
    }
    (entity.quotes ?? []).forEach((q, j) => {
      if (cache.known.get(q.chapter) && !cache.verbatim.get(quoteKey(q.chapter, q.text))) {
        errors.push({
          path: `${prefix(i)}quotes.${j}.text`,
          message: `the quote is not found verbatim in chapter ${q.chapter}`,
        });
      }
    });
  });
  return errors;
}

/**
 * Под замком, перед записью: главы, проверенные до транзакции, перечитываются отпечатком
 * (`md5` текста, без самого текста). Глава удалена или появилась — её номер проверяется заново;
 * текст главы изменился — её цитаты сверяются заново, `checkChapters` дочитает текст. Иначе кэш
 * проверки до транзакции верен и в транзакции.
 */
async function revalidateChapters(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  cache: ChapterCheck,
): Promise<void> {
  const numbers = [...cache.known.keys()];
  if (numbers.length === 0) return;
  const rows = await tx.$queryRaw<{ number: number; digest: string }[]>`
    SELECT "number", md5("content") AS "digest" FROM "Chapter"
    WHERE "bookVersionId" = ${bookVersionId} AND "number" = ANY(${numbers}::int[])`;
  const now = new Map(rows.map((r) => [r.number, r.digest]));
  const forget = (n: number) => {
    cache.known.delete(n);
    cache.digest.delete(n);
    for (const key of [...cache.verbatim.keys()]) {
      if (key.startsWith(`${n}\u0000`)) cache.verbatim.delete(key);
    }
  };
  for (const n of numbers) {
    const changed =
      now.has(n) !== cache.known.get(n) ||
      (cache.digest.has(n) && cache.digest.get(n) !== now.get(n));
    if (changed) forget(n);
  }
}

/**
 * Сверка вкладки для мира книги: как `assertRowAsExpected`, но строки нет, а вкладка видела её
 * `updatedAt` — тоже 409 (сущность удалили; у версии — удалили все). У анализа строка не удаляется.
 */
function assertWorldAsExpected(
  existing: { updatedAt: Date } | null,
  expected: ExpectedRow,
  message: string,
): void {
  if (expected.expectedUpdatedAt !== undefined && existing === null) throw recordChanged(message);
  assertRowAsExpected(existing, expected, message);
}

function throwIfErrors(errors: readonly WorldRefError[]): void {
  if (errors.length > 0) {
    throw new BadRequestException(errors.map((e) => `${e.path}: ${e.message}`));
  }
}

function coreMessage(m: WorldCoreResult['missing'][number]): string {
  if (m.part === 'mentions') {
    return 'mentions: the entity is not found in any chapter yet; the page will not be published';
  }
  if (m.need === 1) return `${m.part} is empty; the page will not be published`;
  return `${m.part}: ${m.have} of ${m.need} with a chapter; the page will not be published`;
}

function savedSummary(p: PlannedEntity) {
  return {
    key: p.merged.key,
    created: p.existing === null,
    hasCore: p.core.hasCore,
    warnings: p.warnings,
  };
}

function withEditor(row: WorldEditorSummaryRow): BookWorldEntitySummaryDto {
  return { ...toSummary(row), editor: editorOf(row) };
}

/** Ключи героев анализа версии: только строки `key` элементов `characters`. */
function analysisCharacterKeys(characters: Prisma.JsonValue | undefined): Set<string> {
  if (!Array.isArray(characters)) return new Set();
  return new Set(
    characters.flatMap((c) => (isRecord(c) && typeof c.key === 'string' ? [c.key] : [])),
  );
}

async function findEntity(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  key: string,
): Promise<WorldEditorRow> {
  const entity = await tx.bookWorldEntity.findUnique({
    where: { bookVersionId_key: { bookVersionId, key } },
    select: BOOK_WORLD_SELECT,
  });
  if (!entity) throw notFoundEntity();
  return entity;
}

/**
 * Время текста модели при изменившем содержание импорте (R9): не раньше `now` и строго позже
 * прежней отметки «прочитано» — иначе отметка с часов, ушедших вперёд, покрыла бы новый текст.
 */
const autoTextStamp = (now: Date, readAt: Date | null) =>
  new Date(Math.max(now.getTime(), (readAt?.getTime() ?? 0) + 1));

/**
 * Запись сущности тела: блоки, ядро, поля публичности (`worldListedWrite`) и, если содержание
 * изменилось, `autoTextAt` (R9: импорт — текст модели; `readAt` не обнуляется).
 */
function writePlanned(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  p: PlannedEntity,
  version: VersionState,
  now: Date,
): Promise<WorldEditorRow> {
  const state = p.existing ?? {
    isVisible: true,
    readAt: null,
    autoTextAt: null,
    firstPublishedAt: null,
    mentions: null,
  };
  const autoTextAt = p.changed ? autoTextStamp(now, state.readAt) : state.autoTextAt;
  const listed = worldListedWrite(
    { ...state, autoTextAt, role: p.merged.role, hasCore: p.core.hasCore },
    version,
    now,
  );
  const coreMissing = p.core.missing.map((m) => m.part);
  // Ничего не изменилось — ни содержание, ни производные поля: запись не нужна, и `updatedAt`
  // (сверка второй вкладки) не сдвигается от повторного импорта того же JSON.
  if (
    p.existing &&
    !p.changed &&
    p.existing.hasCore === p.core.hasCore &&
    stableJson(p.existing.coreMissing) === stableJson(coreMissing) &&
    p.existing.isListed === listed.isListed &&
    listed.firstPublishedAt === undefined
  ) {
    return Promise.resolve(p.existing);
  }
  const data = {
    ...toEntityWrite(p.merged),
    hasCore: p.core.hasCore,
    coreMissing,
    ...(p.changed ? { autoTextAt } : {}),
    ...listed,
  };
  return p.existing
    ? tx.bookWorldEntity.update({
        where: { bookVersionId_key: { bookVersionId, key: p.merged.key } },
        data,
        select: BOOK_WORLD_SELECT,
      })
    : tx.bookWorldEntity.create({
        data: { bookVersionId, key: p.merged.key, ...data },
        select: BOOK_WORLD_SELECT,
      });
}

/**
 * Отметки без смены текста: ядро пересчитывается от сохранённых блоков и присутствия (его пишет
 * не эта ручка), `isListed` и `firstPublishedAt` — заново; `autoTextAt` не трогается (R9).
 */
function updateState(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  entity: WorldEditorRow,
  patch: { readAt?: Date; isVisible?: boolean; isIndexable?: boolean },
  version: VersionState,
): Promise<WorldEditorRow> {
  const core = computeWorldCore({ ...readStoredEntity(entity), mentions: entity.mentions });
  const listed = worldListedWrite(
    { ...entity, ...patch, hasCore: core.hasCore },
    version,
    new Date(),
  );
  return tx.bookWorldEntity.update({
    where: { bookVersionId_key: { bookVersionId, key: entity.key } },
    data: {
      ...patch,
      hasCore: core.hasCore,
      coreMissing: core.missing.map((m) => m.part),
      ...listed,
      // Отметки — не правка сущности (решение арбитра R6): сверка вкладки `expectedUpdatedAt`
      // не должна краснеть от чужого «прочитано» или флага. Явное значение Prisma не перезаписывает.
      updatedAt: entity.updatedAt,
    },
    select: BOOK_WORLD_SELECT,
  });
}
