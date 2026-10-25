import { Injectable, NotFoundException } from '@nestjs/common';
import { Chapter, Prisma, TranslationChunkStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChapterService, LockedChapterWriter } from '../../chapter/chapter.service';
import { assembleTranslatedChapter, ChapterAssembly } from '../assemble/chapter-assembly';
import { rebuiltFindings, StoredFinding, writeRebuiltFindings } from '../assemble/chapter-findings';
import { chapterAssemblyInput } from '../assemble/chapter-input';
import { splitChapter } from '../chapter-blocks';
import { verdictJson } from '../check/chunk-verdict';
import { DRAFT_FLAG_REASONS } from '../draft/draft.constants';
import { metadataStateOf } from '../metadata/metadata-state';
import { staleClosure } from '../run/stale-closure';
import { RUN_TX_OPTIONS } from '../run/translation-run.constants';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { chapterFingerprint } from '../source-fingerprint';
import { TranslatedBlock } from '../translate/translate.format';
import { CHUNK_EDIT_CONFLICT, REWRITE_REFUSALS } from './chunk-retry.constants';
import {
  cancelRetryOperation,
  chargeRetry,
  ChunkRetry,
  lockedRetry,
  retryJson,
  retryOpen,
} from './chunk-retry';

/** Что подменяет кусок: дошедшая до конца попытка повтора или блоки, правленные руками. */
export type ChunkReplacement =
  | { kind: 'retry'; operationId: string }
  | {
      kind: 'manual';
      blocks: TranslatedBlock[];
      /**
       * Замки и проверки до записи в той же транзакции (`lockChunkForWrite` и пара свободна):
       * возвращает попытку повтора под замком строки куска.
       */
      lock: (tx: Prisma.TransactionClient) => Promise<ChunkRetry | null>;
    };

/** Итог подмены: переписана ли глава черновика и почему нет (`rewriteRefusal`). */
export interface ChunkRewriteResult {
  applied: boolean;
  chapterRewritten: boolean;
  reason: string | null;
}

interface LockedChapterRow {
  id: string;
  status: string;
  flagReason: string | null;
  chapterId: string | null;
  writtenHash: string | null;
  findings: Prisma.JsonValue;
}

/**
 * Подмена куска и перезапись главы по Р9 (`F05-7v`; решения арбитра `F05 | F05-7v`) - одной
 * транзакцией: кусок, находки главы, счётчики флагов языка и текст главы черновика. Глава
 * переписывается, только если её текст - тот, что записал конвейер (хэш), версия - черновик и
 * глава собирается из новых кусков; иначе причина - в `rewriteRefusal`, а кусок всё равно новый
 * (Р9: новый перевод виден). Находки сборки пересчитываются бесплатно, ответы моделей - `stale`.
 */
@Injectable()
export class ChunkRewriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly chapters: ChapterService,
  ) {}

  /**
   * Путь записи (перезапись главы черновика или только кусок) выбирается по снимку до замков и
   * перепроверяется под ними: сменился (шаг запуска записал главу, черновик появился) - попытка
   * заново, после `APPLY_ATTEMPTS` - 409 `CHUNK_EDIT_CONFLICT`.
   */
  async apply(chunkId: string, replacement: ChunkReplacement): Promise<ChunkRewriteResult> {
    for (let attempt = 0; attempt < APPLY_ATTEMPTS; attempt++) {
      try {
        return await this.applyOnce(chunkId, replacement);
      } catch (error) {
        if (!(error instanceof PathChangedError)) throw error;
      }
    }
    throw llmTaskConflict(CHUNK_EDIT_CONFLICT, 'The chapter changed concurrently, try again');
  }

  private async applyOnce(
    chunkId: string,
    replacement: ChunkReplacement,
  ): Promise<ChunkRewriteResult> {
    const chunk = await this.prisma.translationChunk.findUnique({
      where: { id: chunkId },
      select: {
        chapterNumber: true,
        runLanguage: {
          select: {
            id: true,
            bookVersionId: true,
            metadata: true,
            run: { select: { bookVersionId: true } },
          },
        },
      },
    });
    if (!chunk) throw new NotFoundException('Translation chunk not found');
    const lang = chunk.runLanguage;
    const row = await this.prisma.translationChapter.findUnique({
      where: {
        runLanguageId_chapterNumber: { runLanguageId: lang.id, chapterNumber: chunk.chapterNumber },
      },
      select: { id: true, status: true },
    });
    const ctx = { chunkId, languageId: lang.id, sourceVersionId: lang.run.bookVersionId };
    const number = chunk.chapterNumber;
    // Глава черновика есть или не записалась - перезапись по Р9; иначе её соберёт сам запуск.
    if (lang.bookVersionId && row && IN_DRAFT_PATH.has(row.status)) {
      const draftId = lang.bookVersionId;
      const titles = metadataStateOf(lang.metadata)?.result?.chapterTitles ?? [];
      try {
        return await this.chapters.rewriteLocked(draftId, (tx, writer) =>
          this.rewrite(tx, writer, ctx, number, row.id, replacement, titles),
        );
      } catch (error) {
        // Черновик удалили - замок прав не нашёл версию: дальше путь без черновика, он запишет
        // `DRAFT_DELETED`. Иной «не найдено» из тела транзакции - не про черновик.
        if (!(error instanceof NotFoundException)) throw error;
        const draft = await this.prisma.bookVersion.findUnique({
          where: { id: draftId },
          select: { id: true },
        });
        if (draft) throw error;
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = row ? await lockChapterRow(tx, row.id) : null;
      const now = await tx.translationRunLanguage.findUniqueOrThrow({
        where: { id: lang.id },
        select: { id: true, bookVersionId: true, draftCreatedAt: true },
      });
      // Черновик появился и глава уже в нём (или не записалась) - это путь перезаписи.
      if (locked && now.bookVersionId !== null && IN_DRAFT_PATH.has(locked.status)) {
        throw new PathChangedError();
      }
      if (!(await swapChunk(tx, ctx, replacement))) return NOT_APPLIED;
      if (!locked) return { applied: true, chapterRewritten: false, reason: null };
      // Черновик удалён (`staleClosure` - одно правило с запуском): глава осталась без него.
      if (staleClosure([now]).deleted.length > 0 && IN_DRAFT_PATH.has(locked.status)) {
        await tx.translationChapter.update({
          where: { id: locked.id },
          data: { rewriteRefusal: REWRITE_REFUSALS.DRAFT_DELETED },
        });
        return { applied: true, chapterRewritten: false, reason: REWRITE_REFUSALS.DRAFT_DELETED };
      }
      // Собранная, но ещё не записанная глава: находки - по новым кускам, запись - шагом запуска.
      if (locked.status === 'assembled' || locked.status === 'flagged') {
        const { assembly } = await assembled(tx, ctx, number);
        const notWritten = notWrittenOf(assembly);
        await writeRebuiltFindings(
          tx,
          ctx.languageId,
          locked,
          rebuiltFindings(locked.findings, assembly?.findings ?? [], notWritten),
          {
            status: notWritten ? 'flagged' : 'assembled',
            length: assembly?.length ?? null,
            rewriteRefusal: null,
          },
          notWritten,
        );
      }
      return { applied: true, chapterRewritten: false, reason: null };
    }, RUN_TX_OPTIONS);
  }

  /** Тело транзакции под замком прав версии черновика: подмена, сверка Р9, запись главы. */
  private async rewrite(
    tx: Prisma.TransactionClient,
    writer: LockedChapterWriter,
    ctx: SwapContext,
    number: number,
    rowId: string,
    replacement: ChunkReplacement,
    titles: ReadonlyArray<{ number: number; title: string }>,
  ): Promise<ChunkRewriteResult> {
    const status = await writer.versionStatus();
    const locked = await lockChapterRow(tx, rowId);
    if (!locked) return NOT_APPLIED;
    // Под замком глава уже не в черновике и не «не записана» - путь сменился.
    if (!IN_DRAFT_PATH.has(locked.status)) throw new PathChangedError();
    if (!(await swapChunk(tx, ctx, replacement))) return NOT_APPLIED;
    const { assembly, sourceTitle } = await assembled(tx, ctx, number);
    if (!assembly || assembly.status !== 'assembled') {
      // Из новых кусков глава не собирается. Не записанная глава - находки по новым кускам
      // (её текста в черновике нет); записанная - прежний текст и его находки остаются.
      const refusal = notWrittenOf(assembly) ?? DRAFT_FLAG_REASONS.SOURCE_CHANGED;
      if (locked.status === 'flagged') {
        await writeRebuiltFindings(
          tx,
          ctx.languageId,
          locked,
          rebuiltFindings(locked.findings, assembly?.findings ?? [], refusal),
          { length: assembly?.length ?? null, rewriteRefusal: refusal },
          refusal,
        );
      } else {
        await this.refuse(tx, locked.id, refusal);
      }
      return { applied: true, chapterRewritten: false, reason: refusal };
    }
    let refusal: string | null = null;
    if (status !== 'draft') refusal = REWRITE_REFUSALS.VERSION_NOT_DRAFT;
    else if (locked.status === 'written') {
      // Глава не от запуска (номер был занят) или текст правили после записи - не трогаем.
      const current = locked.chapterId ? await writer.lockChapter(locked.chapterId) : null;
      if (
        !current ||
        locked.writtenHash === null ||
        chapterFingerprint(current.content) !== locked.writtenHash
      ) {
        refusal = REWRITE_REFUSALS.CHAPTER_EDITED_MANUALLY;
      }
    } else if (await writer.numberTaken(number)) {
      // Не записанную главу редактор уже завёл сам с тем же номером - чужую не трогаем.
      refusal = REWRITE_REFUSALS.CHAPTER_EDITED_MANUALLY;
    }
    // Отказ: в черновике прежний текст главы, её находки описывают его - не пересчитываются
    // (пересчёт по новым кускам дал бы флаг тексту, которого в главе нет); кусок - новый (Р9).
    if (refusal !== null) {
      if (locked.status === 'flagged') {
        // Не записанная глава: её текста в черновике нет - находки и флаг по новым кускам
        // (собирается), а в черновик она не идёт по причине отказа.
        await writeRebuiltFindings(
          tx,
          ctx.languageId,
          locked,
          rebuiltFindings(locked.findings, assembly.findings),
          { length: assembly.length, rewriteRefusal: refusal },
          refusal,
        );
      } else {
        await this.refuse(tx, locked.id, refusal);
      }
      return { applied: true, chapterRewritten: false, reason: refusal };
    }
    const added: StoredFinding[] = [];
    let written: Chapter;
    if (locked.status === 'written' && locked.chapterId) {
      written = await writer.write({
        id: locked.chapterId,
        number,
        title: '',
        content: assembly.content,
      });
    } else {
      // Глава не записывалась (Р8, кусок без перевода): создаётся, раз теперь собирается.
      // Названия нет в ответе `metadata`: пусто и находка, - кроме главы исходника без названия
      // (то же правило, что у записи черновика; решение арбитра `F05 | F05-6`, 6c В2).
      const title = titles.find((t) => t.number === number)?.title;
      if (title === undefined && sourceTitle.trim() !== '') {
        added.push({ code: DRAFT_FLAG_REASONS.TITLE_MISSING });
      }
      written = await writer.write({ number, title: title ?? '', content: assembly.content });
    }
    await writeRebuiltFindings(
      tx,
      ctx.languageId,
      locked,
      [...rebuiltFindings(locked.findings, assembly.findings), ...added],
      {
        status: 'written',
        chapterId: written.id,
        writtenHash: chapterFingerprint(assembly.content),
        length: assembly.length,
        rewriteRefusal: null,
      },
    );
    return { applied: true, chapterRewritten: true, reason: null };
  }

  private async refuse(tx: Prisma.TransactionClient, rowId: string, reason: string): Promise<void> {
    await tx.translationChapter.update({ where: { id: rowId }, data: { rewriteRefusal: reason } });
  }
}

/** Путь записи сменился между снимком и замками - `apply` выбирает его заново. */
class PathChangedError extends Error {}

/** Попыток выбрать путь записи: второй хватает на одну встречную запись главы шагом запуска. */
const APPLY_ATTEMPTS = 2;

/** Глава в черновике или не записалась в него: её путь - перезапись по Р9. */
const IN_DRAFT_PATH: ReadonlySet<string> = new Set(['written', 'flagged']);

const NOT_APPLIED: ChunkRewriteResult = { applied: false, chapterRewritten: false, reason: null };

interface SwapContext {
  chunkId: string;
  languageId: string;
  sourceVersionId: string;
}

/** Строка главы языка под замком транзакции. */
async function lockChapterRow(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<LockedChapterRow | null> {
  const rows = await tx.$queryRaw<LockedChapterRow[]>`
    SELECT "id", "status"::text AS "status", "flagReason", "chapterId", "writtenHash", "findings"
    FROM "TranslationChapter" WHERE "id" = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Сборка главы из кусков транзакции (уже с подменённым) и название главы исходника; сборка `null` -
 * исходник правили после нарезки.
 */
async function assembled(
  tx: Prisma.TransactionClient,
  ctx: SwapContext,
  number: number,
): Promise<{ assembly: ChapterAssembly | null; sourceTitle: string }> {
  const input = await chapterAssemblyInput(tx, ctx.sourceVersionId, ctx.languageId, number);
  if (!input) return { assembly: null, sourceTitle: '' };
  return {
    assembly: assembleTranslatedChapter(splitChapter(input.content), input.chunks),
    sourceTitle: input.title,
  };
}

/** Глава не пойдёт в черновик: исходник правили или сборка не прошла (Р8, кусок без перевода). */
function notWrittenOf(assembly: ChapterAssembly | null) {
  if (!assembly) return DRAFT_FLAG_REASONS.SOURCE_CHANGED;
  return assembly.status === 'assembled' ? null : assembly.flagReason;
}

/**
 * Подмена полей куска под замком его строки. Попытка - только своей операции и дошедшая до
 * перевода (`done`/`checked` без находок глоссария - `done`, `flagged` - флаг с новым текстом);
 * правка руками снимает флаг, ставит отметку и снимает идущую попытку вместе с её операцией.
 * `flaggedChunks` языка - ±1 по переходу флага, условием на счётчик (не ниже нуля).
 */
async function swapChunk(
  tx: Prisma.TransactionClient,
  ctx: SwapContext,
  replacement: ChunkReplacement,
): Promise<boolean> {
  // Правка - общим порядком замков `lockChunkForWrite` (прежняя операция повтора → операция
  // запуска → кусок), иначе встречные кнопки экрана куска - 40P01; повтор - только кусок.
  const retry =
    replacement.kind === 'manual' ? await replacement.lock(tx) : await lockedRetry(tx, ctx.chunkId);
  const current = await tx.translationChunk.findUniqueOrThrow({
    where: { id: ctx.chunkId },
    select: { status: true, costUsd: true, attempts: true },
  });
  let data: Prisma.TranslationChunkUpdateInput;
  let status: TranslationChunkStatus;
  if (replacement.kind === 'retry') {
    if (!retry || retry.operationId !== replacement.operationId) return false;
    if (!['done', 'checked', 'flagged'].includes(retry.status) || !retry.blocks) return false;
    status = retry.status === 'flagged' ? 'flagged' : 'done';
    const applied: ChunkRetry = { ...retry, status: 'applied', reason: retry.flagReason ?? null };
    data = {
      status,
      flagReason: status === 'flagged' ? (retry.flagReason ?? null) : null,
      blocks: retry.blocks as unknown as Prisma.InputJsonValue,
      rawResponse: (retry.rawResponse ?? Prisma.DbNull) as Prisma.InputJsonValue,
      model: retry.model ?? null,
      callId: retry.callId ?? null,
      verdict: retry.verdict ? verdictJson(retry.verdict) : Prisma.DbNull,
      costUsd: (current.costUsd ?? new Prisma.Decimal(0)).add(retry.costUsd),
      attempts: current.attempts + retry.attempts,
      editedAt: null,
      // Без копии перевода: он уже в полях куска.
      retry: retryJson({ ...applied, blocks: undefined, rawResponse: undefined, verdict: null }),
    };
  } else {
    status = 'done';
    data = {
      status,
      flagReason: null,
      blocks: replacement.blocks as unknown as Prisma.InputJsonValue,
      editedAt: new Date(),
      retry: Prisma.DbNull,
      // Замечания проверяющего - к тексту до правки: за новый текст отвечает редактор.
      verdict: Prisma.DbNull,
    };
    // Попытка повтора на паузе: правка руками её отменяет - иначе «продолжить» затёрло бы правку;
    // её оплаченные ответы остаются в стоимости куска.
    if (retryOpen(retry)) {
      await cancelRetryOperation(tx, retry.operationId);
      await chargeRetry(tx, ctx.chunkId, retry);
    }
  }
  await tx.translationChunk.update({ where: { id: ctx.chunkId }, data });
  const was = current.status === 'flagged';
  const now = status === 'flagged';
  if (was !== now) {
    await tx.translationRunLanguage.updateMany({
      where: { id: ctx.languageId, ...(now ? {} : { flaggedChunks: { gt: 0 } }) },
      data: { flaggedChunks: now ? { increment: 1 } : { decrement: 1 } },
    });
  }
  return true;
}
