import { Injectable } from '@nestjs/common';
import {
  Language,
  LlmOperation,
  LlmPauseReason,
  LlmTask,
  Prisma,
  TranslationChunk,
  TranslationRun,
  TranslationRunLanguage,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService, pairKeyOf } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import { ChapterChunk, nextSplit } from '../chunking/chapter-chunks';
import { demandContext } from '../dossier/context-demand';
import { DossierService } from '../dossier/dossier.service';
import { chapterFingerprint, sourceFingerprint } from '../source-fingerprint';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import { pickBoundary } from '../translate/split.stage';
import { SPLIT_STAGE, TRANSLATE_STAGE } from '../translate/translate.constants';
import { glossaryFindingsOf, TranslatedBlock } from '../translate/translate.format';
import { lastTranslated, pieceInput, tailOf } from '../translate/translate-piece';
import { PieceTranslation, translatePiece } from '../translate/translate-step';
import { mergeFindings } from './glossary-findings';
import { runStageModels, StageModels } from './run-models';
import {
  RUN_CHAPTER_CHUNKS_MAX,
  CHUNK_CLOSED_STATUSES,
  CHUNK_INVALID_RESPONSE,
  CHUNK_STATUS_UNEXPECTED,
  CHUNK_TOO_LONG,
  RUN_TX_OPTIONS,
  TRANSLATION_RUN_TASK_KIND,
} from './translation-run.constants';

type RunRow = TranslationRun & { operation: Pick<LlmOperation, 'settingsSnapshot'> };
type LanguageRow = TranslationRunLanguage & { run: RunRow };
/** Кусок без ответа модели: шаги читают главу целиком, ответ нужен одному шагу находок. */
type ChunkRow = Omit<TranslationChunk, 'rawResponse'>;

const UNFINISHED = ['pending', 'running'] as const;
const CLOSED = new Set<TranslationChunk['status']>(CHUNK_CLOSED_STATUSES);
/** Тупиковые причины паузы запуска: выход - отмена или новый запуск (Р13). */
const UNRESUMABLE: readonly LlmPauseReason[] = ['DOSSIER_STALE'];
/** Сброс остановки языка: «продолжить» и готовый контекст. */
const CLEAR_STOP = { reason: null, reasonModels: [], blockedByOperationId: null };

/**
 * Задача языка запуска: ключ пары «операция:язык» (Р1). Без `bookVersionId`: задача от версии
 * каскадом не удаляется, и удаление исходника посреди запуска доходит до шага - тот закрывает
 * операцию `failed`, а не оставляет её `active` без задач.
 */
export function runTaskInput(
  runLanguageId: string,
  language: Language,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: TRANSLATION_RUN_TASK_KIND,
    operationId,
    language,
    payload: { runLanguageId },
    pairKey: pairKeyOf(operationId, language),
  };
}

function runLanguageIdOf(task: LlmTask): string | null {
  const id = (task.payload as Record<string, unknown> | null)?.runLanguageId;
  return typeof id === 'string' ? id : null;
}

function stageModelsOf(run: RunRow, stage: string): StageModels {
  return runStageModels(run.operation.settingsSnapshot, run.stageModels, stage);
}

/**
 * Шаги языка запуска перевода (`F05-4`, шаги 4-6). Шаг за раз: досье и глоссарий (запуск -
 * ждущий, Р20) → глава по порядку: сверка отпечатка, нарезка по стыку за шаг → кусок по
 * порядку: перевод → находки в глоссарий → следующий. Проверок нет (`F05-5`): кусок `done`
 * с пустым вердиктом - «не проверен». Модели этапов - из снимка операции запуска или
 * `stageModels` (решение арбитра `F05 | F05-4a`, В1).
 *
 * 🔴 Ответ модели пишется в кусок (`translated`) до записи итога шага и после продления
 * аренды; находки дописываются отдельным шагом до следующего куска. Повтор после падения
 * находит ответ сохранённым и модель не зовёт - за кусок не платим дважды (`tech.md` §5).
 */
@Injectable()
export class TranslationRunTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierService,
  ) {}

  /** С `DOSSIER_STALE` запуск не продолжают (Р13) - условием записи «продолжить». */
  readonly unresumableReasons = UNRESUMABLE;

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  /**
   * «Продолжить» - задача на каждый недоделанный язык (решение арбитра `F05 | F05-4`). После
   * `DOSSIER_STALE` продолжать нечего (Р13): куски на старом досье, выход - отмена или новый
   * запуск; иначе языки в середине главы переводили бы дальше по устаревшему досье за деньги.
   * Исходник правили, пока запуск стоял на другой паузе, - сверка здесь же (`tech.md` §2а:
   * «не совпал при продолжении запуска - запуск встаёт»): причина паузы меняется на
   * `DOSSIER_STALE`, задач нет, «продолжить» отвечает 409.
   */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    if (op.pauseReason === 'DOSSIER_STALE') return [];
    const run = await this.prisma.translationRun.findUnique({
      where: { operationId: op.id },
      include: { languages: { orderBy: { language: 'asc' } } },
    });
    if (!run || run.languages.length === 0) return [];
    if (run.dossierFingerprint !== null && (await this.isStale(run))) {
      await this.tasks.repauseOperation(op.id, 'DOSSIER_STALE', async (tx) => {
        await tx.translationRunLanguage.updateMany({
          where: { runId: run.id, status: { in: [...UNFINISHED] } },
          data: { ...CLEAR_STOP, reason: 'DOSSIER_STALE' },
        });
      });
      return [];
    }
    const open = run.languages.filter((l) => (UNFINISHED as readonly string[]).includes(l.status));
    // Все языки доделаны, а операция на паузе (пауза пришла вместе с последним шагом): шаг
    // любого языка закроет операцию.
    const languages = open.length > 0 ? open : run.languages.slice(0, 1);
    return languages.map((l) => runTaskInput(l.id, l.language, op.id));
  }

  /** «Продолжить»: причины остановки недоделанных языков сбрасываются той же транзакцией. */
  async onResumed(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.translationRunLanguage.updateMany({
      where: { run: { operationId: op.id }, status: { in: [...UNFINISHED] } },
      data: CLEAR_STOP,
    });
  }

  /**
   * Отменённый запуск: недоделанные языки - `cancelled` в той же транзакции. Куски остаются.
   * Операции досье и глоссария, заведённые ради запуска, не отменяются: их ждут и другие
   * (Р20, решение арбитра `F05 | F05-4a`, В5).
   */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.translationRunLanguage.updateMany({
      where: { run: { operationId: op.id }, status: { in: [...UNFINISHED] } },
      data: { status: 'cancelled' },
    });
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = runLanguageIdOf(task);
    const lang = id
      ? await this.prisma.translationRunLanguage.findUnique({
          where: { id },
          include: { run: { include: { operation: { select: { settingsSnapshot: true } } } } },
        })
      : null;
    // Строки нет (версию удалили - каскад): переводить нечего; уцелевшие языки - `failed` (В6).
    if (!lang) {
      await this.tasks.failOperation(task.operationId, async (tx) => {
        await tx.translationRunLanguage.updateMany({
          where: { run: { operationId: task.operationId }, status: { in: [...UNFINISHED] } },
          data: { status: 'failed' },
        });
      });
      return { kind: 'done' };
    }
    if (!(UNFINISHED as readonly string[]).includes(lang.status)) {
      await this.completeIfFinished(lang.run);
      return { kind: 'done' };
    }
    if (lang.status === 'pending') {
      await this.prisma.translationRunLanguage.updateMany({
        where: { id: lang.id, status: 'pending' },
        data: { status: 'running' },
      });
    }
    if (!lang.run.dossierId || !lang.glossaryId) return this.awaitContext(lang);
    if (lang.chapterNumber === null) return this.startChapter(lang, null);
    return this.chapterStep(lang, lang.chapterNumber, ctx);
  }

  /**
   * Досье и глоссарий языка. Досье запуска одно (Р18): первым готовым привязывается с отпечатком
   * исходника, остальные языки берут глоссарий к нему. Устаревшее на привязке - пауза
   * `DOSSIER_STALE` (Р13).
   */
  private async awaitContext(lang: LanguageRow): Promise<LlmTaskStepResult> {
    const { run } = lang;
    const bound = run.dossierId
      ? await this.prisma.bookDossier.findUnique({ where: { id: run.dossierId } })
      : null;
    const context = await demandContext(this.dossiers, this.tasks, {
      versionId: run.bookVersionId,
      language: lang.language,
      operationId: run.operationId,
      waitingFor: lang.waitingFor,
      dossier: bound,
      translationRunId: run.id,
      // До привязки не переведено ничего: устаревшее готовое досье строится новым поколением,
      // а не останавливает запуск на `DOSSIER_STALE` без выхода.
      rebuildStale: !run.dossierId,
    });
    switch (context.kind) {
      case 'ready': {
        // Исходник по D8 сменился (у книги появилась версия на языке оригинала): досье другой
        // версии к запуску не привязывается - его главы и отпечаток не те, что у запуска, а
        // `NoAction` держит удаление только при досье той же версии (В2).
        if (context.dossier.sourceVersionId !== run.bookVersionId) return this.pauseStale(lang);
        if (!run.dossierId) {
          // Исходник правили, пока строилось досье: до привязки не переведено ничего - шаг
          // повторится и построит новое поколение (`rebuildStale`), а не встанет без выхода.
          const current = await sourceFingerprint(this.prisma, context.dossier.sourceVersionId);
          if (current !== context.dossier.fingerprint) return { kind: 'continue' };
        }
        // Привязка досье запуска и глоссария языка - одной транзакцией. Досье привязал другой
        // язык (другое поколение) - глоссарий этого языка к нему, следующим шагом.
        await this.prisma.$transaction(async (tx) => {
          if (!run.dossierId) {
            await tx.translationRun.updateMany({
              where: { id: run.id, dossierId: null },
              data: {
                dossierId: context.dossier.id,
                dossierFingerprint: context.dossier.fingerprint,
              },
            });
            const fresh = await tx.translationRun.findUniqueOrThrow({
              where: { id: run.id },
              select: { dossierId: true },
            });
            if (fresh.dossierId !== context.dossier.id) return;
          }
          await tx.translationRunLanguage.update({
            where: { id: lang.id },
            data: { glossaryId: context.glossary.id, waitingFor: null, ...CLEAR_STOP },
          });
        }, RUN_TX_OPTIONS);
        return { kind: 'continue' };
      }
      case 'wait':
        if (lang.waitingFor !== context.waitingFor) {
          await this.prisma.translationRunLanguage.update({
            where: { id: lang.id },
            data: { waitingFor: context.waitingFor },
          });
        }
        return { kind: 'wait', reason: context.reason };
      case 'stopped':
        // Операция запуска уже на паузе (её поставил `DossierService`): причина и операция
        // досье - у языка, для «продолжить досье» (`F05-7`).
        await this.prisma.translationRunLanguage.update({
          where: { id: lang.id },
          data: { reason: context.reason, blockedByOperationId: context.blockedBy },
        });
        return { kind: 'continue' };
      // Строку меняли одновременно - «повторить позже», а не отказ.
      case 'retry':
        return { kind: 'wait', reason: context.code };
      case 'failed':
        await this.prisma.translationRunLanguage.update({
          where: { id: lang.id },
          data: { reason: context.code },
        });
        return { kind: 'fail', reason: context.code };
    }
  }

  /** Глава после `after` по порядку номеров; нет - язык доделан. */
  private async startChapter(lang: LanguageRow, after: number | null): Promise<LlmTaskStepResult> {
    const next = await this.prisma.chapter.findFirst({
      where: {
        bookVersionId: lang.run.bookVersionId,
        ...(after === null ? {} : { number: { gt: after } }),
      },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    if (!next) return this.finishLanguage(lang);
    await this.prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { chapterNumber: next.number, splitPicks: {} },
    });
    return { kind: 'continue' };
  }

  private async chapterStep(
    lang: LanguageRow,
    number: number,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const [chapter, chunks] = await Promise.all([
      this.prisma.chapter.findUnique({
        where: { bookVersionId_number: { bookVersionId: lang.run.bookVersionId, number } },
        select: { content: true },
      }),
      this.prisma.translationChunk.findMany({
        where: { runLanguageId: lang.id, chapterNumber: number },
        orderBy: { chunkIndex: 'asc' },
        omit: { rawResponse: true },
        take: RUN_CHAPTER_CHUNKS_MAX,
      }),
    ]);
    // Главу удалили посреди запуска - исходник уже не тот, что у досье.
    if (!chapter) return this.pauseStale(lang);
    if (chunks.length === 0) {
      // Перед нарезкой главы - сверка отпечатка исходника с досье запуска (`tech.md` §2а, В3):
      // один раз на главу, а не на каждом куске и шаге стыка - отпечаток читает весь текст.
      const started = Object.keys((lang.splitPicks ?? {}) as object).length > 0;
      if (!started && (await this.isStale(lang.run))) return this.pauseStale(lang);
      return this.splitStep(lang, number, chapter.content, ctx, started);
    }
    // Главу правили после нарезки: куски уже не те - как правка исходника посреди запуска.
    if (chapterFingerprint(chapter.content) !== chunks[0].chapterFingerprint) {
      return this.pauseStale(lang);
    }
    const next = chunks.find((c) => !CLOSED.has(c.status));
    if (!next) return this.startChapter(lang, number);
    if (next.status === 'translated') return this.applyFindings(lang, next.id, ctx);
    // В перевод - только `pending`: кусок в статусе, которого этот шаг не знает (`checked` -
    // `F05-5`), повторный платный вызов не получает - шаг отказывает, запуск встаёт на паузу.
    if (next.status !== 'pending') {
      // Итог `fail` исполнитель на паузу не переводит (`onFailed` не зовётся) - пауза ставится
      // здесь, иначе операция осталась бы `active` без задач.
      return this.stopRun(lang, 'STEP_FAILED', { reason: CHUNK_STATUS_UNEXPECTED });
    }
    return this.translateStep(lang, number, splitChapter(chapter.content), chunks, next, ctx);
  }

  /**
   * Нарезка главы - по одному спорному стыку за шаг, как у сравнения (`F05-3`): выбор модели
   * `split` пишется до конца шага, повтор его не оплачивает. Глава без блоков - один пустой
   * кусок: её переводить нечего, но порядок глав держится по кускам.
   */
  private async splitStep(
    lang: LanguageRow,
    number: number,
    content: string,
    ctx: LlmTaskContext,
    started: boolean,
  ): Promise<LlmTaskStepResult> {
    const picks = { ...((lang.splitPicks ?? {}) as Record<string, number>) };
    const split = await nextSplit(splitChapter(content), picks);
    if ('open' in split) {
      picks[split.open.key] = await pickBoundary(
        this.llm,
        lang.run.operationId,
        split.open.window,
        ctx,
        stageModelsOf(lang.run, SPLIT_STAGE),
      );
      await ctx.renewLease();
      await this.prisma.translationRunLanguage.update({
        where: { id: lang.id },
        data: { splitPicks: picks as unknown as Prisma.InputJsonValue },
      });
      return { kind: 'continue' };
    }
    // Нарезка шла несколько шагов (спорные стыки) - исходник могли править между ними: сверка
    // ещё раз перед записью кусков, иначе куски получили бы отпечаток уже правленой главы.
    if (started && (await this.isStale(lang.run))) return this.pauseStale(lang);
    const chunks: ChapterChunk[] =
      split.chunks.length > 0 ? split.chunks : [{ firstBlock: 0, lastBlock: 0, words: 0 }];
    const fingerprint = chapterFingerprint(content);
    await ctx.renewLease();
    await this.prisma.translationChunk.createMany({
      data: chunks.map((c, chunkIndex) => ({
        runLanguageId: lang.id,
        chapterNumber: number,
        chunkIndex,
        firstBlock: c.firstBlock,
        lastBlock: c.lastBlock,
        words: c.words,
        chapterFingerprint: fingerprint,
      })),
      skipDuplicates: true,
    });
    return { kind: 'continue' };
  }

  private async translateStep(
    lang: LanguageRow,
    number: number,
    layout: ChapterLayout,
    chunks: ChunkRow[],
    chunk: ChunkRow,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const { run } = lang;
    const [dossier, glossary] = await Promise.all([
      this.prisma.bookDossier.findUnique({
        where: { id: run.dossierId ?? '' },
        select: { data: true },
      }),
      this.prisma.bookGlossary.findUnique({
        where: { id: lang.glossaryId ?? '' },
        select: { data: true },
      }),
    ]);
    const before = chunks
      .filter((c) => c.chunkIndex < chunk.chunkIndex)
      .map((c) => (c.blocks ?? []) as unknown as TranslatedBlock[]);
    const previous = lastTranslated(before);
    const input = pieceInput({
      layout,
      chunks: chunks.map((c) => ({
        firstBlock: c.firstBlock,
        lastBlock: c.lastBlock,
        words: c.words,
      })),
      index: chunk.chunkIndex,
      dossier: dossier?.data ?? null,
      glossary: glossary?.data ?? null,
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      chapterNumber: number,
      previousTail: previous ? tailOf(previous) : null,
    });
    const models = stageModelsOf(run, TRANSLATE_STAGE);
    let piece: PieceTranslation;
    try {
      piece = await translatePiece(this.llm, run.operationId, input, layout, ctx, models);
    } catch (error) {
      if (error instanceof LlmError && error.code === 'LLM_NO_COMPLIANT_PROVIDER') {
        return this.pauseNoProvider(lang, models);
      }
      throw error;
    }
    await ctx.renewLease();
    switch (piece.kind) {
      // Кусок без переводимых блоков (только `hr` и картинки без подписей): модель не звалась.
      case 'empty':
        await this.prisma.translationChunk.updateMany({
          where: { id: chunk.id, status: 'pending' },
          data: { status: 'done', blocks: [] },
        });
        return { kind: 'continue' };
      case 'too_long':
        return this.flagChunk(lang, chunk, CHUNK_TOO_LONG);
      case 'invalid':
        return this.flagChunk(lang, chunk, CHUNK_INVALID_RESPONSE, piece.costUsd);
      case 'translated':
        await this.prisma.translationChunk.updateMany({
          where: { id: chunk.id, status: 'pending' },
          data: {
            status: 'translated',
            attempts: { increment: 1 },
            rawResponse: piece.raw as Prisma.InputJsonValue,
            blocks: piece.blocks as unknown as Prisma.InputJsonValue,
            model: piece.model,
            callId: piece.callId,
            costUsd: piece.costUsd,
          },
        });
        return { kind: 'continue' };
    }
  }

  /**
   * Находки куска - в глоссарий языка до следующего куска, вместе с `done` одной транзакцией.
   * Строка глоссария под замком: шаг другого исполнителя с истёкшей арендой не перепишет её
   * прочитанным раньше снимком (L-019).
   */
  private async applyFindings(
    lang: LanguageRow,
    chunkId: string,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const chunk = await this.prisma.translationChunk.findUniqueOrThrow({
      where: { id: chunkId },
      select: { id: true, rawResponse: true },
    });
    const findings = glossaryFindingsOf(chunk.rawResponse);
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ data: Prisma.JsonValue; history: Prisma.JsonValue }>>`
        SELECT "data", "history" FROM "BookGlossary" WHERE "id" = ${lang.glossaryId} FOR UPDATE`;
      const row = rows[0];
      // Повтор шага держит сам кусок: `translated → done` в этой же транзакции.
      if (row) {
        const dossier = await tx.bookDossier.findUnique({
          where: { id: lang.run.dossierId ?? '' },
          select: { data: true },
        });
        const merged = mergeFindings(row.data, row.history, chunk.id, findings, dossier?.data);
        if (merged.added.length > 0) {
          await tx.bookGlossary.update({
            where: { id: lang.glossaryId ?? '' },
            data: {
              data: merged.data as unknown as Prisma.InputJsonValue,
              history: merged.history as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }
      await tx.translationChunk.updateMany({
        where: { id: chunk.id, status: 'translated' },
        data: { status: 'done' },
      });
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /** Ошибка содержания после повторов - флаг куска, язык идёт дальше (`tech.md` §5). */
  private async flagChunk(
    lang: LanguageRow,
    chunk: ChunkRow,
    reason: string,
    costUsd: Prisma.Decimal | null = null,
  ): Promise<LlmTaskStepResult> {
    await this.prisma.$transaction(async (tx) => {
      const flagged = await tx.translationChunk.updateMany({
        where: { id: chunk.id, status: 'pending' },
        // Попытка - шаг, дошедший до модели: у `too_long` вызова не было.
        data: {
          status: 'flagged',
          flagReason: reason,
          costUsd,
          attempts: { increment: costUsd ? 1 : 0 },
        },
      });
      if (flagged.count > 0) {
        await tx.translationRunLanguage.update({
          where: { id: lang.id },
          data: { flaggedChunks: { increment: 1 } },
        });
      }
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Отпечаток исходника не совпал с привязанным к запуску (`tech.md` §2а). Досье запуска -
   * той же версии, что запуск (привязка другой не проходит), поэтому сверка - по версии запуска.
   */
  private async isStale(run: TranslationRun): Promise<boolean> {
    const current = await sourceFingerprint(this.prisma, run.bookVersionId);
    return current !== run.dossierFingerprint;
  }

  /**
   * Все модели этапа отказали по политике данных (Р7): пауза `NO_COMPLIANT_PROVIDER` ставится
   * самим шагом - он знает, какие модели передал в вызов, и пишет их языку (решение арбитра
   * `F05 | F05-4a`, В4). Выход - «продолжить» со `stageModels`.
   */
  private async pauseNoProvider(
    lang: LanguageRow,
    models: StageModels,
  ): Promise<LlmTaskStepResult> {
    const tried = await this.llm.stageCallModels(TRANSLATE_STAGE, models);
    return this.stopRun(lang, 'NO_COMPLIANT_PROVIDER', {
      reason: 'LLM_NO_COMPLIANT_PROVIDER',
      reasonModels: tried,
    });
  }

  /**
   * Пауза запуска с причиной и записью языка. Операция уже стоит (кнопка «пауза» пришла, пока шёл
   * шаг) - причина всё равно меняется: иначе «продолжить» не узнало бы, что запуск встал по
   * исходнику или провайдерам, и сняло бы причину языка.
   */
  private async stopRun(
    lang: LanguageRow,
    reason: LlmPauseReason,
    data: Prisma.TranslationRunLanguageUpdateInput,
  ): Promise<LlmTaskStepResult> {
    // `DOSSIER_STALE` - тупик (Р13): другой причиной его не перекрыть, иначе экран предложил
    // бы «продолжить» запуску, который продолжать нельзя.
    await this.tasks.stopOrRepause(
      lang.run.operationId,
      reason,
      async (tx) => {
        await tx.translationRunLanguage.update({ where: { id: lang.id }, data });
      },
      UNRESUMABLE,
    );
    return { kind: 'continue' };
  }

  /** Исходник правили посреди запуска: пауза `DOSSIER_STALE`, выход - отмена или новый запуск (Р13). */
  private async pauseStale(lang: LanguageRow): Promise<LlmTaskStepResult> {
    return this.stopRun(lang, 'DOSSIER_STALE', { reason: 'DOSSIER_STALE' });
  }

  /**
   * Язык доделан. Недоделанные считаются после записи своего `done`: из двух языков,
   * закончивших одновременно, тот, кто считает позже, видит оба и закрывает операцию.
   */
  private async finishLanguage(lang: LanguageRow): Promise<LlmTaskStepResult> {
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...UNFINISHED] } },
      data: { status: 'done', reason: null },
    });
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  private async completeIfFinished(run: TranslationRun): Promise<void> {
    const open = await this.prisma.translationRunLanguage.count({
      where: { runId: run.id, status: { in: [...UNFINISHED] } },
    });
    if (open === 0) await this.tasks.completeOperation(run.operationId);
  }

  private async onFailed(task: LlmTask, reason: string): Promise<void> {
    const id = runLanguageIdOf(task);
    await this.tasks.pauseOperation(
      task.operationId,
      PAUSE_BY_FAILURE[reason] ?? 'STEP_FAILED',
      id
        ? async (tx) => {
            await tx.translationRunLanguage.updateMany({ where: { id }, data: { reason } });
          }
        : undefined,
    );
  }
}
