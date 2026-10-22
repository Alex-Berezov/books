import { HttpException, Injectable } from '@nestjs/common';
import {
  LlmOperation,
  LlmTask,
  Prisma,
  TranslationCompare,
  TranslationCompareModel,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { assembleChapter, ChapterLayout, splitChapter } from '../chapter-blocks';
import {
  ChapterChunk,
  ContestedWindow,
  fallbackBoundary,
  planChunks,
} from '../chunking/chapter-chunks';
import { Demand, DossierService } from '../dossier/dossier.service';
import { callShaped, ShapedAnswer } from '../llm-shaped-call';
import { pickBoundary } from '../translate/split.stage';
import { TRANSLATE_REMARKS, TRANSLATE_STAGE } from '../translate/translate.constants';
import {
  blockText,
  cleanedBlockErrors,
  TranslatedBlock,
  TRANSLATE_SHAPE,
  translateBlockErrors,
} from '../translate/translate.format';
import { lastTranslated, pieceInput, tailOf } from '../translate/translate-piece';
import { translateRequest } from '../translate/translate.prompts';
import {
  COMPARE_CHAPTER_CHANGED,
  COMPARE_CHAPTER_TOO_LONG,
  COMPARE_INVALID_RESPONSE,
  COMPARE_MODEL_ERRORS,
  COMPARE_PAUSE_BY_FAILURE,
  COMPARE_TOO_LONG,
} from './compare.constants';
import { chapterFingerprint, compareTaskInput } from './compare.service';

type CompareRow = TranslationCompare & { models: TranslationCompareModel[] };

const UNFINISHED = ['queued', 'running'] as const;

/** Отказы `demandDossier`/`demandGlossary` «изменено одновременно, повторить»: ожидание, не пауза. */
const CONTEXT_RETRY_CODES = new Set(['DOSSIER_BUSY', 'GLOSSARY_BUSY']);

function compareIdOf(task: LlmTask): string | null {
  const id = (task.payload as Record<string, unknown> | null)?.compareId;
  return typeof id === 'string' ? id : null;
}

/** Код отказа ручки досье (409/503 с `code` в теле), которым шаг ставит свою операцию на паузу. */
function httpCode(error: HttpException): string {
  const body = error.getResponse();
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : null;
  return typeof code === 'string' && code ? code : `HTTP_${error.getStatus()}`;
}

/**
 * Шаги сравнения (`F05-3`; решения арбитра `F05 | F05-3`, С2, С3, С8, С9). Одна задача на
 * операцию: сначала ждёт досье и глоссарий (их строят свои операции, сравнение - ждущий по Р20),
 * затем режет главу, затем переводит по куску одной модели за шаг в порядке колонок. Отказ модели
 * пишется в её колонку, и задача идёт к следующей; бюджет - пауза всей операции, «продолжить»
 * доводит с первого несделанного куска.
 *
 * 🔴 Кусок пишется до записи итога шага и после продления аренды: упал после ответа - повтор
 * найдёт кусок сохранённым и модель не позовёт (как `BookDossierPart`, В3 `F05-2`).
 */
@Injectable()
export class CompareTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierService,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason),
  };

  async resumeTask(op: LlmOperation): Promise<EnqueueTaskInput | null> {
    const row = await this.prisma.translationCompare.findUnique({
      where: { operationId: op.id },
      select: { id: true, bookVersionId: true, language: true },
    });
    return row ? compareTaskInput(row.id, row.bookVersionId, row.language, op.id) : null;
  }

  /** Отменённое сравнение: недоделанные колонки `cancelled` в той же транзакции. */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    await tx.translationCompareModel.updateMany({
      where: { compare: { operationId: op.id }, status: { in: [...UNFINISHED] } },
      data: { status: 'cancelled' },
    });
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = compareIdOf(task);
    const row = id
      ? await this.prisma.translationCompare.findUnique({
          where: { id },
          include: { models: { orderBy: { position: 'asc' } } },
        })
      : null;
    // Строки нет (версию удалили - каскад): сравнивать нечего.
    if (!row) {
      await this.tasks.failOperation(task.operationId);
      return { kind: 'done' };
    }
    // Колонок в работе не осталось - сравнение закрывается по их итогу раньше сверки текста:
    // правка главы после последней колонки не делает отказом уже готовый результат.
    const current = row.models.find((m) => m.status === 'queued' || m.status === 'running');
    if (!current) {
      // Ни одна модель не дала главы - это отказ сравнения, а не «готово» без результата.
      if (row.models.every((m) => m.status === 'failed')) {
        await this.tasks.failOperation(row.operationId);
        return { kind: 'done' };
      }
      await this.tasks.completeOperation(row.operationId);
      return { kind: 'done' };
    }
    const chapter = await this.prisma.chapter.findUnique({
      where: {
        bookVersionId_number: { bookVersionId: row.bookVersionId, number: row.chapterNumber },
      },
      select: { content: true },
    });
    if (!chapter || chapterFingerprint(chapter.content) !== row.chapterFingerprint) {
      return this.failAll(row, COMPARE_CHAPTER_CHANGED);
    }
    if (!row.dossierId || !row.glossaryId) return this.awaitContext(row);

    const layout = splitChapter(chapter.content);
    if (!Array.isArray(row.chunks)) return this.splitStep(row, layout, ctx);
    const chunks = row.chunks as unknown as ChapterChunk[];
    if (current.status === 'queued') {
      await this.prisma.translationCompareModel.updateMany({
        where: { id: current.id, status: 'queued' },
        data: { status: 'running' },
      });
    }
    const done = await this.prisma.translationCompareChunk.findMany({
      where: { compareModelId: current.id },
      orderBy: { chunkIndex: 'asc' },
      take: chunks.length,
    });
    if (done.length >= chunks.length) {
      await this.finishModel(current, layout, done);
      return { kind: 'continue' };
    }
    return this.translateChunk(row, current, layout, chunks, done, ctx);
  }

  private async translateChunk(
    row: CompareRow,
    current: TranslationCompareModel,
    layout: ChapterLayout,
    chunks: ChapterChunk[],
    done: Array<{ chunkIndex: number; blocks: Prisma.JsonValue }>,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const index = done.length;
    const [dossier, glossary] = await Promise.all([
      this.prisma.bookDossier.findUnique({ where: { id: row.dossierId ?? '' } }),
      this.prisma.bookGlossary.findUnique({ where: { id: row.glossaryId ?? '' } }),
    ]);
    const previous = lastTranslated(
      done.slice(0, index).map((c) => c.blocks as unknown as TranslatedBlock[]),
    );
    const input = pieceInput({
      layout,
      chunks,
      index,
      dossier: dossier?.data ?? null,
      glossary: glossary?.data ?? null,
      sourceLanguage: row.sourceLanguage,
      targetLanguage: row.language,
      chapterNumber: row.chapterNumber,
      previousTail: previous ? tailOf(previous) : null,
    });
    const expected = input.blocks.map((b) => b.n);
    // Кусок без переводимых блоков (только `hr` и картинки без подписей): модель не зовётся.
    if (expected.length === 0) return this.saveChunk(current, index, [], null, ctx);
    const request = translateRequest(input);
    const fit = await this.llm.stageFit(TRANSLATE_STAGE, request, current.model);
    if (!fit.fits) return this.failModel(current, COMPARE_TOO_LONG);

    const kinds = new Map(layout.blocks.map((b) => [b.n, b]));
    let answer: ShapedAnswer;
    try {
      answer = await callShaped(
        this.llm,
        row.operationId,
        TRANSLATE_STAGE,
        request,
        TRANSLATE_SHAPE,
        ctx,
        {
          remarks: TRANSLATE_REMARKS,
          model: current.model,
          extraErrors: (value) => {
            const numbers = translateBlockErrors(value, expected);
            return numbers.length > 0 ? numbers : cleanedBlockErrors(value, kinds);
          },
        },
      );
    } catch (error) {
      if (error instanceof LlmError && COMPARE_MODEL_ERRORS.has(error.code)) {
        return this.failModel(current, error.code);
      }
      throw error;
    }
    if (!answer.ok) return this.failModel(current, COMPARE_INVALID_RESPONSE);

    // Только `n` и `text` блоков куска: прочее в ответе не хранится.
    const blocks = (answer.value as { blocks: TranslatedBlock[] }).blocks
      .filter((b) => expected.includes(b.n))
      .map((b) => ({
        n: b.n,
        text: blockText(kinds.get(b.n) ?? { kind: 'p' as const, html: '' }, b.text),
      }));
    return this.saveChunk(current, index, blocks, answer.callId, ctx);
  }

  private async saveChunk(
    current: TranslationCompareModel,
    index: number,
    blocks: TranslatedBlock[],
    callId: string | null,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    await ctx.renewLease();
    await this.prisma.translationCompareChunk.createMany({
      data: [
        {
          compareModelId: current.id,
          chunkIndex: index,
          blocks: blocks as unknown as Prisma.InputJsonValue,
          callId,
        },
      ],
      skipDuplicates: true,
    });
    return { kind: 'continue' };
  }

  /**
   * Нарезка - по одному спорному стыку за шаг: выбор модели `split` пишется до конца шага, и
   * повтор после обрыва или паузы по лимиту его не оплачивает. Нарезка каждый раз проходит
   * главу заново по сохранённым выборам; нового стыка нет - куски пишутся.
   */
  private async splitStep(
    row: CompareRow,
    layout: ChapterLayout,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const picks = { ...((row.splitPicks ?? {}) as Record<string, number>) };
    let open: { key: string; window: ContestedWindow } | null = null;
    const chunks = await planChunks(layout, (window) => {
      const key = String(window.candidates[0].block);
      if (key in picks) return Promise.resolve(picks[key]);
      open ??= { key, window };
      // Дальше по главе этот проход не пишется: стык выбирается моделью следующим шагом.
      return Promise.resolve(fallbackBoundary(window));
    });
    const pending = open as { key: string; window: ContestedWindow } | null;
    if (pending) {
      picks[pending.key] = await pickBoundary(this.llm, row.operationId, pending.window, ctx);
      await ctx.renewLease();
      await this.prisma.translationCompare.update({
        where: { id: row.id },
        data: { splitPicks: picks as unknown as Prisma.InputJsonValue },
      });
      return { kind: 'continue' };
    }
    await ctx.renewLease();
    await this.prisma.translationCompare.update({
      where: { id: row.id },
      data: { chunks: chunks as unknown as Prisma.InputJsonValue },
    });
    return { kind: 'continue' };
  }

  /** Все куски модели переведены: глава собирается кодом, без проверки стыков (С3, стыки - `F05-6`). */
  private async finishModel(
    current: TranslationCompareModel,
    layout: ChapterLayout,
    done: Array<{ blocks: Prisma.JsonValue }>,
  ): Promise<void> {
    const replacements = new Map<number, string>();
    for (const chunk of done) {
      for (const b of chunk.blocks as unknown as TranslatedBlock[]) replacements.set(b.n, b.text);
    }
    const html = sanitizeRichHtml(assembleChapter(layout, replacements));
    if (html.length > RICH_HTML_MAX_LENGTH.body) {
      await this.failModel(current, COMPARE_CHAPTER_TOO_LONG);
      return;
    }
    await this.prisma.translationCompareModel.updateMany({
      where: { id: current.id, status: { in: [...UNFINISHED] } },
      data: { status: 'done', html },
    });
  }

  private async failModel(
    current: TranslationCompareModel,
    error: string,
  ): Promise<LlmTaskStepResult> {
    await this.prisma.translationCompareModel.updateMany({
      where: { id: current.id, status: { in: [...UNFINISHED] } },
      data: { status: 'failed', error },
    });
    return { kind: 'continue' };
  }

  /** Отказ всего сравнения: операция `failed`, недоделанные колонки - с причиной, одной записью. */
  private async failAll(row: CompareRow, reason: string): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(row.operationId, async (tx) => {
      await tx.translationCompareModel.updateMany({
        where: { compareId: row.id, status: { in: [...UNFINISHED] } },
        data: { status: 'failed', error: reason },
      });
    });
    return { kind: 'fail', reason };
  }

  /**
   * Досье и глоссарий языка (С2): сравнение - ждущий. `wait` - строится, шаг перепроверит;
   * `paused`/`failed` - операция сравнения уже на паузе (её поставил `DossierService`), шаг
   * кончается, задача закрывается `cancelled`. Отказ ручки досье (409/503) - пауза `STEP_FAILED`
   * с кодом в задаче, а не безымянный `STEP_ERROR`.
   */
  private async awaitContext(row: CompareRow): Promise<LlmTaskStepResult> {
    const options = { waiter: { operationId: row.operationId, waitingFor: row.waitingFor } };
    try {
      const dossier = await this.dossiers.demandDossier(row.bookVersionId, options);
      if (dossier.status !== 'ready') return await this.notReady(row, dossier, 'DOSSIER_BUILDING');
      const glossary = await this.dossiers.demandGlossary(dossier.row.id, row.language, options);
      if (glossary.status !== 'ready')
        return await this.notReady(row, glossary, 'GLOSSARY_BUILDING');
      await this.prisma.translationCompare.update({
        where: { id: row.id },
        data: { dossierId: dossier.row.id, glossaryId: glossary.row.id, waitingFor: null },
      });
      return { kind: 'continue' };
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const code = httpCode(error);
      // Строку меняли одновременно - «повторить позже», а не отказ: шаг ждёт и перепроверит.
      if (CONTEXT_RETRY_CODES.has(code)) return { kind: 'wait', reason: code };
      await this.tasks.pauseOperation(row.operationId, 'STEP_FAILED');
      return { kind: 'fail', reason: code };
    }
  }

  private async notReady<Row extends { id: string }>(
    row: CompareRow,
    demand: Exclude<Demand<Row>, { status: 'ready' }>,
    reason: string,
  ): Promise<LlmTaskStepResult> {
    if (demand.status !== 'wait') return { kind: 'continue' };
    if (row.waitingFor !== demand.row.id) {
      await this.prisma.translationCompare.update({
        where: { id: row.id },
        data: { waitingFor: demand.row.id },
      });
    }
    return { kind: 'wait', reason };
  }

  private async onFailed(task: LlmTask, reason: string): Promise<void> {
    await this.tasks.pauseOperation(
      task.operationId,
      COMPARE_PAUSE_BY_FAILURE[reason] ?? 'STEP_FAILED',
    );
  }
}
