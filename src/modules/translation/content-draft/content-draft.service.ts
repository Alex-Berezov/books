import { Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { BookDossier, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { moneyUsd } from '../../llm/dto/llm-money';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { ContextEstimate, DossierDemandService } from '../dossier/dossier-demand.service';
import { DossierService } from '../dossier/dossier.service';
import {
  CONTENT_DRAFT_TASK_KIND,
  DOSSIER_STALE,
  DRAFT_DOSSIER_MISSING,
  DRAFT_LIMIT_FACTOR,
  RETIRED_DRAFT_KINDS,
} from './content-draft.constants';
import type { RunKind } from '../draft-quality/run-regen';

/**
 * Задача строки снятого вида (`RETIRED_DRAFT_KINDS`): «Continue» её операции ставит задачу, которую
 * обработчик отбросит дренажем (А1). Ключ пары «операция:заготовка» - второй задачи не поставит.
 */
export function draftTaskInput(draft: {
  id: string;
  bookVersionId: string;
  language: Language;
  operationId: string;
}): EnqueueTaskInput {
  return {
    kind: CONTENT_DRAFT_TASK_KIND,
    operationId: draft.operationId,
    bookVersionId: draft.bookVersionId,
    language: draft.language,
    payload: { draftId: draft.id },
    pairKey: `${draft.operationId}:${draft.id}`,
  };
}

type ContextLine = NonNullable<ContextEstimate['glossary']>;
type DossierLine = NonNullable<ContextEstimate['dossier']>;

/** Досье и глоссарий заготовки и строки оценки тех, что строятся первыми. */
export interface DraftContext {
  run: { dossierId: string; glossaryId: string | null } | null;
  dossier: BookDossier | null;
  glossaryData: unknown;
  dossierLine: (ContextLine & Pick<DossierLine, 'refusedTooLong'>) | null;
  glossaryLine: ContextLine | null;
}

/**
 * Лимит поверх контекста (В9, Р4 `F05-10`): max(вызовы × 1,5, лимиты досье и глоссария, которые
 * строятся первыми), и строки досье и глоссария для ответа оценки. Одно правило на заготовки и
 * ход пересказа `F06-2`. Повторы с замечанием (Р28) вызывающий закладывает в `stageUsd`.
 */
export function contextLimits(context: DraftContext, stageUsd: Prisma.Decimal) {
  const maxOf = (values: Array<Prisma.Decimal | undefined>) =>
    values.reduce<Prisma.Decimal>((max, v) => (v && v.gt(max) ? v : max), new Prisma.Decimal(0));
  const contextLimitUsd = maxOf([
    context.dossierLine?.suggestedLimitUsd,
    context.glossaryLine?.suggestedLimitUsd,
  ]);
  const suggestedLimitUsd = maxOf([stageUsd.mul(DRAFT_LIMIT_FACTOR), contextLimitUsd]);
  const line = (l: ContextLine) => ({
    estimateUsd: moneyUsd(l.estimateUsd),
    suggestedLimitUsd: moneyUsd(l.suggestedLimitUsd),
    upperBound: l.upperBound,
  });
  const { dossierLine, glossaryLine } = context;
  return {
    suggestedLimitUsd,
    contextLimitUsd,
    dossier: dossierLine
      ? { ...line(dossierLine), refusedTooLong: dossierLine.refusedTooLong }
      : null,
    glossary: glossaryLine ? line(glossaryLine) : null,
  };
}

/** Сколько строк снятых видов дренаж отбрасывает за одну выборку (`findMany` с пределом). */
const RETIRED_DRAIN_BATCH = 100;

/**
 * Общее для ходов `summary_write` и `analysis_write`: досье и глоссарий хода, вид хода по строке и
 * дренаж снятых заготовок. Заготовки сняты все: пошаговые Summary `F05-10` в `F06-3`, Analysis
 * «Draft from dossier» `F05-11` в `F07-3a` (решения арбитра `F06 | F06-3`, А1; `F07 | F07-3`):
 * при старте строящиеся отбрасываются, ручек у них нет.
 */
@Injectable()
export class ContentDraftService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContentDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierService,
    private readonly dossierDemand: DossierDemandService,
  ) {}

  /**
   * Дренаж снятых видов при старте (решение арбитра `F06 | F06-3`, А1): сбой не роняет старт -
   * строку, чья задача придёт к обработчику, отбросит тот же путь (`discardRetired`).
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const drained = await this.drainRetiredDrafts();
      if (drained > 0) this.logger.log(`Retired drafts discarded: ${drained}`);
    } catch (error) {
      this.logger.error(
        `Retired drafts were not drained: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Строящиеся заготовки снятых видов - `discarded`, их операции `cancelled`, `pending`-задачи
   * `cancelled` тем же путём, что прежний «Discard draft» (`tech.md` §3, А1). Отбор - по строкам
   * снятых видов и их `operationId`. Готовые и упавшие строки не трогаются. Повтор ничего
   * не меняет. Возвращает число отброшенных строк.
   */
  async drainRetiredDrafts(): Promise<number> {
    let drained = 0;
    for (;;) {
      const rows = await this.prisma.contentDraft.findMany({
        where: { kind: { in: [...RETIRED_DRAFT_KINDS] }, status: 'building' },
        select: { id: true, operationId: true },
        orderBy: { createdAt: 'asc' },
        take: RETIRED_DRAIN_BATCH,
      });
      for (const row of rows) await this.discardRetired(row);
      drained += rows.length;
      if (rows.length < RETIRED_DRAIN_BATCH) return drained;
    }
  }

  /** Строящаяся строка снятого вида - `discarded` с отменой её операции (А1). */
  async discardRetired(row: { id: string; operationId: string }): Promise<void> {
    await this.dropRow(row.id, row.operationId);
  }

  /**
   * Вид хода для общих ручек `content-drafts/:id/*` (`F07-1b`, решение арбитра `F07 | F07-1`, В6):
   * одна выборка строки; нет строки или вид не ход (снятая заготовка) - 404.
   */
  async runKindOf(id: string): Promise<RunKind> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      select: { kind: true },
    });
    if (row?.kind !== 'summary_write' && row?.kind !== 'analysis_write') {
      throw new NotFoundException('Run not found');
    }
    return row.kind;
  }

  /**
   * Строящаяся - отмена операции и `discarded` одной транзакцией (В10); операция уже кончилась,
   * а строка осталась строящейся - только статус (иначе дренаж выбирал бы её снова). Строка,
   * успевшая стать готовой или упавшей, не трогается.
   */
  private async dropRow(id: string, operationId: string): Promise<void> {
    await this.tasks.cancelOperation(operationId, async (tx) => {
      await tx.contentDraft.updateMany({
        where: { id, status: 'building' },
        data: { status: 'discarded' },
      });
    });
    await this.prisma.contentDraft.updateMany({
      where: { id, status: 'building' },
      data: { status: 'discarded' },
    });
  }

  async languageOf(versionId: string): Promise<Language | null> {
    const row = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true },
    });
    return row?.language ?? null;
  }

  /**
   * Досье и глоссарий хода - общие для ходов анализа и пересказа (решение арбитра `F05 | F05-11`,
   * Р14): у переведённой версии - досье и глоссарий запуска (Р18, без свежести), иначе
   * действующее поколение досье исходника - устаревшее даёт 409 `DOSSIER_STALE`, отсутствующее
   * строится первым строкой оценки (Р5). Глоссарий не нужен на языке досье (В6).
   */
  async draftContext(versionId: string, version: { language: Language }): Promise<DraftContext> {
    const run = await this.dossierDemand.finishedRunContextOf(versionId);
    if (run) {
      if (!run.dossier || run.dossier.status !== 'ready') {
        throw llmTaskConflict(
          DRAFT_DOSSIER_MISSING,
          'The dossier of the translation run that made this version is gone',
        );
      }
      let glossaryData: unknown = null;
      if (run.glossaryId) {
        const glossary = await this.prisma.bookGlossary.findUnique({
          where: { id: run.glossaryId },
          select: { data: true },
        });
        glossaryData = glossary?.data ?? null;
      }
      return {
        run: { dossierId: run.dossier.id, glossaryId: run.glossaryId },
        dossier: run.dossier,
        glossaryData,
        dossierLine: null,
        glossaryLine: null,
      };
    }
    const status = await this.dossiers.status(versionId);
    if (status.status === 'ready' && status.fresh === false) {
      throw llmTaskConflict(
        DOSSIER_STALE,
        'The source changed after the dossier was built: rebuild the dossier',
      );
    }
    const sourceLanguage = await this.languageOf(status.sourceVersionId);
    const needsGlossary = sourceLanguage !== version.language;
    const context = await this.dossierDemand.contextEstimate(versionId, version.language);
    const glossaryLine = needsGlossary ? context.glossary : null;
    const dossier =
      status.status === 'ready'
        ? await this.dossierDemand.latestDossier(status.sourceVersionId)
        : null;
    let glossaryData: unknown = null;
    if (dossier && needsGlossary && glossaryLine === null) {
      const glossary = await this.prisma.bookGlossary.findUnique({
        where: { dossierId_language: { dossierId: dossier.id, language: version.language } },
        select: { data: true, status: true },
      });
      glossaryData = glossary?.status === 'ready' ? glossary.data : null;
    }
    return {
      run: null,
      dossier,
      glossaryData,
      dossierLine: context.dossier ? { ...context.dossier, upperBound: false } : null,
      glossaryLine,
    };
  }
}
