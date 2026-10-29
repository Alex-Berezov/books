import { Injectable } from '@nestjs/common';
import { Prisma, TranslationChunk } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import { ChapterChunk, nextSplit } from '../chunking/chapter-chunks';
import { chapterFingerprint } from '../source-fingerprint';
import { pickBoundary } from '../translate/split.stage';
import { SPLIT_STAGE } from '../translate/translate.constants';
import { glossaryFindingsOf } from '../translate/translate.format';
import {
  checkChunk,
  ChunkStepInput,
  ChunkStepResult,
  ChunkStore,
  ChunkWrite,
  costAdded,
  translateChunk,
} from '../translate/chunk-steps';
import { verdictJson } from '../check/chunk-verdict';
import { mergeFindings } from './glossary-findings';
import {
  RUN_CHAPTER_CHUNKS_MAX,
  CHUNK_CLOSED_STATUSES,
  CHUNK_STATUS_UNEXPECTED,
  RUN_TX_OPTIONS,
} from './translation-run.constants';
import {
  LanguageRow,
  ChunkRow,
  RunStepSupportService,
  stageModelsOf,
} from './run-step-support.service';
import { AssemblyRunStepsService } from './assembly-run-steps.service';

const CLOSED = new Set<TranslationChunk['status']>(CHUNK_CLOSED_STATUSES);

/**
 * Статус, до которого ветка шага дойти не может: закрытый кусок отбирает `CLOSED`. Параметр -
 * ровно закрытые статусы: новый статус схемы без своей ветки в `chapterStep` - ошибка сборки.
 */
function assertClosed(status: 'done' | 'flagged'): void {
  void status;
}

/**
 * Глава по порядку: сверка отпечатка, нарезка по стыку за шаг → кусок по порядку: перевод →
 * проверки (`F05-5`: механика кодом, Jev, сверка смысла моделью другого семейства) → находки
 * в глоссарий → следующий. Провал проверки - перевод заново с замечаниями, вторая неудача - флаг
 * (`CHECK_FAILURES_MAX`).
 *
 * 🔴 Ответ модели пишется в кусок (`translated`) до записи итога шага и после продления
 * аренды; находки дописываются отдельным шагом до следующего куска. Повтор после падения
 * находит ответ сохранённым и модель не зовёт - за кусок не платим дважды (`tech.md` §5).
 */
@Injectable()
export class ChunkRunStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly support: RunStepSupportService,
    private readonly assembly: AssemblyRunStepsService,
  ) {}

  /** Глава после `after` по порядку номеров; нет - сборка глав (`F05-6`). */
  async startChapter(
    lang: LanguageRow,
    after: number | null,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const next = await this.prisma.chapter.findFirst({
      where: {
        bookVersionId: lang.run.bookVersionId,
        ...(after === null ? {} : { number: { gt: after } }),
      },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    if (!next) return this.assembly.assemblyStep(lang, ctx);
    await this.prisma.translationRunLanguage.update({
      where: { id: lang.id },
      data: { chapterNumber: next.number, splitPicks: {} },
    });
    return { kind: 'continue' };
  }

  async chapterStep(
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
    if (!chapter) return this.support.pauseStale(lang);
    if (chunks.length === 0) {
      // Перед нарезкой главы - сверка отпечатка исходника с досье запуска (`tech.md` §2а, В3):
      // один раз на главу, а не на каждом куске и шаге стыка - отпечаток читает весь текст.
      const started = Object.keys((lang.splitPicks ?? {}) as object).length > 0;
      if (!started && (await this.support.isStale(lang.run))) return this.support.pauseStale(lang);
      return this.splitStep(lang, number, chapter.content, ctx, started);
    }
    // Главу правили после нарезки: куски уже не те - как правка исходника посреди запуска.
    if (chapterFingerprint(chapter.content) !== chunks[0].chapterFingerprint) {
      return this.support.pauseStale(lang);
    }
    const next = chunks.find((c) => !CLOSED.has(c.status));
    if (!next) return this.startChapter(lang, number, ctx);
    if (next.status === 'checked') return this.applyFindings(lang, next.id, ctx);
    const layout = splitChapter(chapter.content);
    if (next.status === 'translated') {
      return this.checkStep(lang, number, layout, chunks, next, ctx);
    }
    // В перевод - только `pending`: закрытые куски отобраны выше (`CLOSED`), а новый статус
    // схемы без своей ветки не соберётся (`assertClosed`) - иначе он ушёл бы в перевод, который
    // пишется только из `pending`, и шаг платил бы по кругу.
    if (next.status !== 'pending') {
      // Итог `fail` исполнитель на паузу не переводит (`onFailed` не зовётся) - пауза ставится
      // здесь, иначе операция осталась бы `active` без задач.
      assertClosed(next.status);
      return this.support.stopRun(lang, 'STEP_FAILED', { reason: CHUNK_STATUS_UNEXPECTED });
    }
    return this.translateStep(lang, number, layout, chunks, next, ctx);
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
    if (started && (await this.support.isStale(lang.run))) return this.support.pauseStale(lang);
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

  /** Перевод куска - общий шаг (`translate/chunk-steps.ts`), запись в строку куска запуска. */
  private async translateStep(
    lang: LanguageRow,
    number: number,
    layout: ChapterLayout,
    chunks: ChunkRow[],
    chunk: ChunkRow,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const input = await this.stepInput(lang, number, layout, chunks, ctx);
    return this.stepResult(lang, await translateChunk(input, chunk, this.runStore(lang, chunk)));
  }

  /** Проверки куска - общий шаг (`translate/chunk-steps.ts`), запись в строку куска запуска. */
  private async checkStep(
    lang: LanguageRow,
    number: number,
    layout: ChapterLayout,
    chunks: ChunkRow[],
    chunk: ChunkRow,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const input = await this.stepInput(lang, number, layout, chunks, ctx);
    return this.stepResult(lang, await checkChunk(input, chunk, this.runStore(lang, chunk)));
  }

  private async stepInput(
    lang: LanguageRow,
    number: number,
    layout: ChapterLayout,
    chunks: ChunkRow[],
    ctx: LlmTaskContext,
  ): Promise<ChunkStepInput> {
    const { run } = lang;
    const { dossier, glossary } = await this.support.contextOf(lang);
    return {
      llm: this.llm,
      operationId: run.operationId,
      ctx,
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      chapterNumber: number,
      layout,
      chunks,
      dossier,
      glossary,
      models: (stage) => stageModelsOf(run, stage),
    };
  }

  private stepResult(lang: LanguageRow, result: ChunkStepResult): Promise<LlmTaskStepResult> {
    if (result.kind === 'no_provider') {
      return this.support.pauseNoProvider(lang, result.stage, result.models);
    }
    return Promise.resolve({ kind: 'continue' });
  }

  /**
   * Запись шагов в строку куска запуска условием статуса. Флаг - со счётчиком флагов языка той
   * же транзакцией: ошибка содержания после повторов, язык идёт дальше (`tech.md` §5).
   */
  private runStore(lang: LanguageRow, chunk: ChunkRow): ChunkStore {
    const data = (write: ChunkWrite): Prisma.TranslationChunkUpdateManyMutationInput => ({
      ...(write.status ? { status: write.status } : {}),
      ...(write.rawResponse !== undefined
        ? { rawResponse: write.rawResponse as Prisma.InputJsonValue }
        : {}),
      ...(write.blocks ? { blocks: write.blocks as unknown as Prisma.InputJsonValue } : {}),
      ...(write.model !== undefined ? { model: write.model } : {}),
      ...(write.callId !== undefined ? { callId: write.callId } : {}),
      ...(write.costUsd ? { costUsd: costAdded(chunk.costUsd, write.costUsd) } : {}),
      ...(write.attempt ? { attempts: { increment: 1 } } : {}),
      ...(write.verdict ? { verdict: verdictJson(write.verdict) } : {}),
    });
    return {
      write: async (from, write) => {
        await this.prisma.translationChunk.updateMany({
          where: { id: chunk.id, status: from },
          data: data(write),
        });
      },
      flag: async (from, reason, write) => {
        await this.prisma.$transaction(async (tx) => {
          const flagged = await tx.translationChunk.updateMany({
            where: { id: chunk.id, status: from },
            data: { ...data(write), status: 'flagged', flagReason: reason },
          });
          if (flagged.count > 0) {
            await tx.translationRunLanguage.update({
              where: { id: lang.id },
              data: { flaggedChunks: { increment: 1 } },
            });
          }
        }, RUN_TX_OPTIONS);
      },
    };
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
      // Повтор шага держит сам кусок: `checked → done` в этой же транзакции.
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
        where: { id: chunk.id, status: 'checked' },
        data: { status: 'done' },
      });
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }
}
