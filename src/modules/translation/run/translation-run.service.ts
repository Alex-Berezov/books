import { Injectable, NotFoundException } from '@nestjs/common';
import { LlmOperation, Prisma, TranslationRunLanguage } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmOperationsService } from '../../llm-worker/llm-operations.service';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { DOSSIER_MAX_CHAPTERS } from '../dossier/dossier.constants';
import { assertKnownModels, stageEstimatorFor } from '../llm-model-checks';
import { CHUNK_CLOSED_STATUSES } from './translation-run.constants';
import {
  ResumeTranslationRunDto,
  TranslationRunStageModelsDto,
} from '../dto/translation-run-request.dto';
import {
  TranslationRunDto,
  TranslationRunLanguageDto,
  TranslationRunStage,
} from '../dto/translation-run-response.dto';

/**
 * Ход запуска перевода и кнопки «пауза», «продолжить», «отменить» (`F05-4`, шаги 6-7). Старта
 * здесь нет - его ручка, оценка и замок языка приходят с `F05-4b` (решение арбитра `F05 | F05-4`).
 * Переходы - общими методами операций: отмена закрывает языки (`onCancelled`), «продолжить»
 * ставит задачу на каждый недоделанный язык (`resumeTasks`).
 */
@Injectable()
export class TranslationRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly operations: LlmOperationsService,
  ) {}

  async get(id: string): Promise<TranslationRunDto> {
    const run = await this.prisma.translationRun.findUnique({
      where: { id },
      include: { operation: true, languages: { orderBy: { language: 'asc' } } },
    });
    if (!run) throw new NotFoundException('Translation run not found');
    const [chapters, chunks] = await Promise.all([
      // Номера глав исходника - для «глава N из M»; глав не больше предела досье.
      this.prisma.chapter.findMany({
        where: { bookVersionId: run.bookVersionId },
        select: { number: true },
        orderBy: { number: 'asc' },
        take: DOSSIER_MAX_CHAPTERS,
      }),
      // Строк не больше, чем языков × статусов куска: группировка, а не выборка кусков.
      this.prisma.translationChunk.groupBy({
        by: ['runLanguageId', 'chapterNumber', 'status'],
        where: {
          OR: run.languages
            .filter((l) => l.chapterNumber !== null)
            .map((l) => ({ runLanguageId: l.id, chapterNumber: l.chapterNumber as number })),
        },
        _count: { _all: true },
      }),
    ]);
    const numbers = chapters.map((c) => c.number);
    return {
      id: run.id,
      bookVersionId: run.bookVersionId,
      sourceLanguage: run.sourceLanguage,
      dossierId: run.dossierId,
      stageModels: (run.stageModels ?? {}) as TranslationRunStageModelsDto,
      operation: toOperationDto(run.operation),
      createdAt: run.createdAt.toISOString(),
      languages: run.languages.map((l) =>
        languageDto(
          l,
          run.dossierId !== null,
          numbers,
          chunks.filter((c) => c.runLanguageId === l.id && c.chapterNumber === l.chapterNumber),
        ),
      ),
    };
  }

  /** Пауза кнопкой: причины нет (`pauseReason: null`), шаг, который идёт, доделывается (Р19). */
  async pause(id: string): Promise<TranslationRunDto> {
    const op = await this.operationOf(id);
    if (!(await this.tasks.pauseOperation(op.id, null))) {
      throw llmTaskConflict('TRANSLATION_RUN_NOT_PAUSABLE', 'Translation run is not running');
    }
    return this.get(id);
  }

  /**
   * «Продолжить» с новым лимитом и моделями этапов. Модели пишутся транзакцией «продолжить»,
   * после перевода операции в `active` и до постановки задач: отказ (лимит, повтор куска)
   * откатывает и их, шаг, взятый сразу после, уже на них. Строка операции к этому моменту
   * под замком - второе «продолжить» читает модели после первого.
   */
  async resume(id: string, dto: ResumeTranslationRunDto): Promise<TranslationRunDto> {
    const op = await this.operationOf(id);
    // Отказ «продолжить» - раньше проверки моделей: не на паузе или в тупике - код отказа
    // операции, а не модели, и без лишнего запроса каталога.
    if (op.status !== 'paused' || op.pauseReason === 'DOSSIER_STALE') {
      throw llmTaskConflict('LLM_OPERATION_NOT_RESUMABLE', 'LLM operation cannot be resumed');
    }
    // Только заданные этапы: `{ translate: undefined }` модели не стирает.
    const changed = Object.fromEntries(
      Object.entries(dto.stageModels ?? {}).filter(([, model]) => model !== undefined),
    ) as Record<string, string>;
    if (Object.keys(changed).length > 0) await this.assertStageModels(changed);
    await this.operations.resume(
      op.id,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
      Object.keys(changed).length > 0
        ? async (tx) => {
            const run = await tx.translationRun.findUniqueOrThrow({
              where: { id },
              select: { stageModels: true },
            });
            await tx.translationRun.update({
              where: { id },
              data: { stageModels: { ...(run.stageModels as Record<string, string>), ...changed } },
            });
          }
        : undefined,
    );
    return this.get(id);
  }

  async cancel(id: string): Promise<TranslationRunDto> {
    const op = await this.operationOf(id);
    await this.operations.cancel(op.id);
    return this.get(id);
  }

  private async operationOf(id: string): Promise<LlmOperation> {
    const run = await this.prisma.translationRun.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!run) throw new NotFoundException('Translation run not found');
    return run.operation;
  }

  /**
   * Модель этапа - из каталога OpenRouter, с ценой и на включённом этапе: иначе первый же шаг
   * встал бы на ту же паузу. Правило семейств перевода и проверки - `F05-5`.
   */
  private async assertStageModels(stageModels: Record<string, string>): Promise<void> {
    // Какие этапы можно сменить и что значение - строка, держит `TranslationRunStageModelsDto`.
    await assertKnownModels(this.llm, Object.values(stageModels));
    for (const [stage, model] of Object.entries(stageModels)) {
      await stageEstimatorFor(this.llm, stage, model);
    }
  }
}

function languageDto(
  l: TranslationRunLanguage,
  hasDossier: boolean,
  chapters: readonly number[],
  chunks: Array<{ status: string; _count: { _all: number } }>,
): TranslationRunLanguageDto {
  const total = chunks.reduce((sum, c) => sum + c._count._all, 0);
  const done = chunks
    .filter((c) => (CHUNK_CLOSED_STATUSES as readonly string[]).includes(c.status))
    .reduce((sum, c) => sum + c._count._all, 0);
  const position = l.chapterNumber === null ? -1 : chapters.indexOf(l.chapterNumber);
  return {
    language: l.language,
    status: l.status,
    stage: stageOf(l, hasDossier),
    reason: l.reason,
    // Колонка в базе допускает NULL (строки до записи причины): наружу - пустой список.
    reasonModels: l.reasonModels ?? [],
    chapterNumber: l.chapterNumber,
    chapterPosition: position >= 0 ? position + 1 : null,
    chaptersTotal: chapters.length,
    chunksDone: done,
    chunksTotal: total,
    flaggedChunks: l.flaggedChunks,
    glossaryId: l.glossaryId,
    blockedByOperationId: l.blockedByOperationId,
  };
}

/**
 * Этап языка словами `product.md` §2.3: досье, глоссарий, перевод (с нарезкой главы); у
 * закончившего - его статус (решение арбитра `F05 | F05-4a`, В6). Проверка и сборка - `F05-5`,
 * `F05-6`.
 */
function stageOf(l: TranslationRunLanguage, hasDossier: boolean): TranslationRunStage {
  if (l.status === 'done' || l.status === 'failed' || l.status === 'cancelled') return l.status;
  if (!hasDossier) return 'dossier';
  return l.glossaryId ? 'translate' : 'glossary';
}
