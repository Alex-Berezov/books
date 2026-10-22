import { Injectable } from '@nestjs/common';
import { LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { callShaped, ShapedAnswer } from '../llm-shaped-call';
import { sourceFingerprint } from '../source-fingerprint';
import {
  DOSSIER_INVALID_RESPONSE,
  DOSSIER_MAX_CHAPTERS,
  DOSSIER_SOURCE_CHANGED,
  DOSSIER_STAGE,
  DOSSIER_TOO_LONG,
  GLOSSARY_STAGE,
} from './dossier.constants';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import {
  DOSSIER_FORMAT_VERSION,
  DOSSIER_PART_SHAPE,
  DOSSIER_SHAPE,
  dossierChapterErrors,
  GLOSSARY_SHAPE,
  Shape,
} from './dossier.format';
import { nextPlannedPart, partKey, planChapterParts, readPlan } from './dossier-parts';
import {
  dossierPartRequest,
  dossierSummaryRequest,
  glossaryRequest,
  ShapedRequest,
} from './dossier.prompts';
import { DossierService, dossierTaskInput, glossaryTaskInput } from './dossier.service';

function payloadId(task: LlmTask, key: 'dossierId' | 'glossaryId'): string | null {
  const payload = task.payload as Record<string, unknown> | null;
  const id = payload?.[key];
  return typeof id === 'string' ? id : null;
}

/**
 * Шаги построения досье и глоссария (`F05-2`, шаг 7). Досье - по куску главы за шаг
 * (`continue`), затем сводка; глоссарий - один шаг. Каждый вызов - под операцией строителя
 * с опциями исполнителя: аренда продлевается перед каждой попыткой.
 *
 * 🔴 Частичное досье пишется до записи итога шага и условием по аренде (`renewLease`): упал
 * после ответа - повтор найдёт кусок сохранённым и модель не позовёт (решение арбитра
 * `F05 | F05-2`, В3). Строка `ready` - условием по строителю: перехваченную строку прежний
 * строитель не допишет (`L-019`).
 */
@Injectable()
export class DossierTasksHandler implements LlmOperationKindHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierService,
  ) {}

  readonly dossierHandler: LlmTaskHandler = {
    run: (task, ctx) => this.runDossier(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason, 'bookDossier'),
  };

  readonly glossaryHandler: LlmTaskHandler = {
    run: (task, ctx) => this.runGlossary(task, ctx),
    onFailed: (task, reason) => this.onFailed(task, reason, 'bookGlossary'),
  };

  /** «Продолжить» операцию вида `dossier`: шаг строки, которую она строит (В5). */
  async resumeTasks(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    const dossier = await this.prisma.bookDossier.findFirst({
      where: { operationId: op.id, status: 'building' },
      select: { id: true, sourceVersionId: true },
    });
    if (dossier) return [dossierTaskInput(dossier.id, dossier.sourceVersionId, op.id)];
    const glossary = await this.prisma.bookGlossary.findFirst({
      where: { operationId: op.id, status: 'building' },
      select: { id: true, language: true, dossier: { select: { sourceVersionId: true } } },
    });
    if (!glossary) return [];
    return [
      glossaryTaskInput(glossary.id, glossary.language, glossary.dossier.sourceVersionId, op.id),
    ];
  }

  /** Отменённый строитель: строка `failed`, перехвата нет (Р20). */
  async onCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    const where = { operationId: op.id, status: 'building' as const };
    await tx.bookDossier.updateMany({ where, data: { status: 'failed' } });
    await tx.bookGlossary.updateMany({ where, data: { status: 'failed' } });
  }

  /**
   * Текст исходника правили посреди построения: перехват такой строки бессмыслен, куски уже
   * не те. Строка закрывается вместе с операцией, следующий запрос строит новое поколение.
   */
  private async sourceChanged(rowId: string, operationId: string): Promise<LlmTaskStepResult> {
    await this.tasks.failOperation(operationId, async (tx) => {
      await this.dossiers.failRow('bookDossier', rowId, operationId, tx, {
        failedReason: DOSSIER_SOURCE_CHANGED,
      });
    });
    return { kind: 'fail', reason: DOSSIER_SOURCE_CHANGED };
  }

  private async runDossier(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = payloadId(task, 'dossierId');
    const row = id ? await this.prisma.bookDossier.findUnique({ where: { id } }) : null;
    if (row?.status === 'ready' && row.operationId === task.operationId) {
      // Строка уже `ready`, а процесс упал до закрытия операции: шаг закрывает её сам.
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    // Строки нет (версию удалили - каскад): строить нечего, операция закрывается отказом.
    if (!row) {
      await this.tasks.failOperation(task.operationId);
      return { kind: 'done' };
    }
    // Строку перехватили или она уже не строится: шаг этой задачи больше никому не нужен.
    if (row.status !== 'building' || row.operationId !== task.operationId) {
      return { kind: 'done' };
    }
    if ((await sourceFingerprint(this.prisma, row.sourceVersionId)) !== row.fingerprint) {
      return this.sourceChanged(row.id, task.operationId);
    }
    const plan = readPlan(row.plan);
    const savedKeys = await this.prisma.bookDossierPart.findMany({
      where: { dossierId: row.id },
      select: { chapterNumber: true, partIndex: true },
      take: plan.reduce((sum, e) => sum + e.parts, 0),
    });
    const next = nextPlannedPart(
      plan,
      new Set(savedKeys.map((p) => partKey(p.chapterNumber, p.partIndex))),
    );

    if (next) {
      // Читается только глава этого куска: шаг не тянет всю книгу.
      const chapter = await this.prisma.chapter.findUnique({
        where: {
          bookVersionId_number: { bookVersionId: row.sourceVersionId, number: next.chapterNumber },
        },
        select: { number: true, title: true, content: true },
      });
      const part = chapter ? planChapterParts(chapter)[next.partIndex] : undefined;
      if (!part) {
        return this.sourceChanged(row.id, task.operationId);
      }
      const answer = await this.callShaped(
        task.operationId,
        DOSSIER_STAGE,
        dossierPartRequest(part),
        DOSSIER_PART_SHAPE,
        ctx,
      );
      if (!answer.ok) {
        await this.failBuild('bookDossier', row.id, task.operationId, row.takeovers);
        return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
      }
      await ctx.renewLease();
      await this.prisma.bookDossierPart.createMany({
        data: [
          {
            dossierId: row.id,
            chapterNumber: part.chapterNumber,
            partIndex: part.partIndex,
            data: answer.value as Prisma.InputJsonValue,
            callId: answer.callId,
          },
        ],
        skipDuplicates: true,
      });
      return { kind: 'continue' };
    }

    // Сводка: названия глав и все частичные досье - один раз за построение.
    const [chapters, parts] = await Promise.all([
      this.prisma.chapter.findMany({
        where: { bookVersionId: row.sourceVersionId },
        select: { number: true, title: true },
        orderBy: { number: 'asc' },
        take: DOSSIER_MAX_CHAPTERS,
      }),
      this.prisma.bookDossierPart.findMany({
        where: { dossierId: row.id },
        select: { chapterNumber: true, partIndex: true, data: true },
        orderBy: [{ chapterNumber: 'asc' }, { partIndex: 'asc' }],
        // Кусков не больше, чем в плане строки: выборка ограничена им.
        take: plan.reduce((sum, e) => sum + e.parts, 0),
      }),
    ]);
    const planned = plan.map((e) => e.chapterNumber);
    const summary = dossierSummaryRequest({ chapters, parts });
    const stage = await this.llm.stageFit(DOSSIER_STAGE, summary);
    if (!stage.fits) {
      // Сводка не влезает в контекст: вызов заплатил бы и отказал. Строка `failed` сразу,
      // без перехвата; модель - чтобы ждущий не строил ту же строку той же моделью заново.
      await this.tasks.failOperation(task.operationId, async (tx) => {
        await this.dossiers.failRow('bookDossier', row.id, task.operationId, tx, {
          failedReason: DOSSIER_TOO_LONG,
          model: stage.model,
        });
      });
      return { kind: 'fail', reason: DOSSIER_TOO_LONG };
    }
    const answer = await this.callShaped(
      task.operationId,
      DOSSIER_STAGE,
      summary,
      DOSSIER_SHAPE,
      ctx,
      (value) =>
        dossierChapterErrors(
          value,
          planned,
          chapters.map((c) => c.number),
        ),
    );
    if (!answer.ok) {
      await this.failBuild('bookDossier', row.id, task.operationId, row.takeovers);
      return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
    }
    await ctx.renewLease();
    // Строка `ready` и закрытие операции - одной записью: отказ закрытия не оставит готовое досье
    // под операцией `failed`. Строку уже перехватили - операцию закрывает перехватчик.
    await this.tasks.completeOperation(task.operationId, async (tx) => {
      await tx.bookDossier.updateMany({
        where: { id: row.id, status: 'building', operationId: task.operationId },
        data: {
          status: 'ready',
          data: answer.value as Prisma.InputJsonValue,
          formatVersion: DOSSIER_FORMAT_VERSION,
          model: answer.model,
        },
      });
    });
    return { kind: 'done' };
  }

  private async runGlossary(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const id = payloadId(task, 'glossaryId');
    const row = id
      ? await this.prisma.bookGlossary.findUnique({ where: { id }, include: { dossier: true } })
      : null;
    if (row?.status === 'ready' && row.operationId === task.operationId) {
      await this.tasks.completeOperation(task.operationId);
      return { kind: 'done' };
    }
    if (!row) {
      await this.tasks.failOperation(task.operationId);
      return { kind: 'done' };
    }
    if (row.status !== 'building' || row.operationId !== task.operationId) {
      return { kind: 'done' };
    }
    const answer = await this.callShaped(
      task.operationId,
      GLOSSARY_STAGE,
      glossaryRequest({ dossier: row.dossier.data, language: row.language }),
      GLOSSARY_SHAPE,
      ctx,
    );
    if (!answer.ok) {
      await this.failBuild('bookGlossary', row.id, task.operationId, row.takeovers);
      return { kind: 'fail', reason: DOSSIER_INVALID_RESPONSE };
    }
    await ctx.renewLease();
    await this.tasks.completeOperation(task.operationId, async (tx) => {
      await tx.bookGlossary.updateMany({
        where: { id: row.id, status: 'building', operationId: task.operationId },
        data: { status: 'ready', data: answer.value as Prisma.InputJsonValue, model: answer.model },
      });
    });
    return { kind: 'done' };
  }

  /**
   * Вызов с ответом по форме: не по форме или не JSON - один повтор с замечанием, затем отказ.
   * Прочие отказы модуля LLM уходят исполнителю: бюджет - пауза, остальное - `failed`.
   */
  private callShaped(
    operationId: string,
    stage: string,
    request: ShapedRequest,
    shape: Shape,
    ctx: LlmTaskContext,
    extraErrors?: (value: unknown) => string[],
  ): Promise<ShapedAnswer> {
    return callShaped(this.llm, operationId, stage, request, shape, ctx, {
      remarks: 1,
      extraErrors,
    });
  }

  /**
   * Отказ строителя не по бюджету (Р20): операция `failed`, строка ждёт одного перехвата.
   * Упал уже перехватчик - строка `failed`, её заново строит следующий, кому она нужна.
   */
  private async failBuild(
    model: 'bookDossier' | 'bookGlossary',
    rowId: string,
    operationId: string,
    takeovers: number,
  ): Promise<void> {
    await this.tasks.failOperation(operationId, async (tx) => {
      if (takeovers > 0) await this.dossiers.failRow(model, rowId, operationId, tx);
    });
  }

  private async onFailed(
    task: LlmTask,
    reason: string,
    model: 'bookDossier' | 'bookGlossary',
  ): Promise<void> {
    const pause = PAUSE_BY_FAILURE[reason];
    if (pause) {
      await this.tasks.pauseOperation(task.operationId, pause);
      return;
    }
    const id = payloadId(task, model === 'bookDossier' ? 'dossierId' : 'glossaryId');
    if (!id) return;
    const row =
      model === 'bookDossier'
        ? await this.prisma.bookDossier.findUnique({ where: { id } })
        : await this.prisma.bookGlossary.findUnique({ where: { id } });
    if (!row || row.operationId !== task.operationId) return;
    await this.failBuild(model, row.id, task.operationId, row.takeovers);
  }
}
