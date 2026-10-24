import { Injectable } from '@nestjs/common';
import {
  LlmOperation,
  LlmPauseReason,
  LlmTask,
  Prisma,
  TranslationChunk,
  TranslationRun,
  TranslationRunLanguage,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmOperationKindHandler } from '../../llm-worker/llm-operation-kind.registry';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { assembleTranslatedChapter } from '../assemble/chapter-assembly';
import {
  ASSEMBLY_CHUNK_SELECT,
  chapterAssemblyInput,
  chunksOfChapter,
  InputChunk,
} from '../assemble/chapter-input';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import { ChapterChunk, nextSplit } from '../chunking/chapter-chunks';
import { demandContext } from '../dossier/context-demand';
import { DossierService } from '../dossier/dossier.service';
import { CREATE_FROM_RUN_REJECTIONS } from '../../book-version/create-from-run';
import { DRAFT_DELETED, NO_CHAPTERS_WRITTEN } from '../draft/draft.constants';
import { TranslationDraftService } from '../draft/translation-draft.service';
import { chapterFingerprint, sourceFingerprint } from '../source-fingerprint';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import { pickBoundary } from '../translate/split.stage';
import { SPLIT_STAGE, TRANSLATE_STAGE } from '../translate/translate.constants';
import { glossaryFindingsOf, TranslatedBlock } from '../translate/translate.format';
import {
  chunkBlocks,
  doneRunBefore,
  glossaryFor,
  lastTranslated,
  pieceInput,
  tailOf,
} from '../translate/translate-piece';
import { PieceTranslation, translatePiece } from '../translate/translate-step';
import {
  CHECK_FAILURES_MAX,
  CHECK_FLAG_REASONS,
  CHECK_JEV_STAGE,
  CHECK_SEMANTIC_STAGE,
  CHECK_NO_COMPLIANT_PROVIDER,
} from '../check/check.constants';
import {
  attemptSeed,
  cappedRemarks,
  CheckAttempt,
  emptyVerdict,
  ChunkVerdict,
  currentAttempt,
  verdictJson,
  verdictOf,
} from '../check/chunk-verdict';
import { checkJev } from '../check/jev-step';
import { jevFailure } from '../check/jev-check';
import {
  CheckFailure,
  checkMechanical,
  nameEntriesOf,
  pieceTexts,
} from '../check/mechanical-check';
import { semanticFailed, semanticFailures } from '../check/semantic-check';
import { callIndependent, translatorsOf } from '../check/independent-call';
import { checkSemantic, semanticInputOf } from '../check/semantic-step';
import {
  addChapterFindings,
  CHAPTER_FINDINGS_SELECT,
  ChapterFindingsRow,
} from '../assemble/chapter-findings';
import {
  nextSeam,
  SEAM_FINDING_CODES,
  SEAM_SHAPE,
  seamAnswerOf,
  seamFailed,
  SeamFinding,
  seamFindingsOf,
  seamInputOf,
  seamProblems,
  seamRequest,
} from '../check/seam-check';
import { DOSSIER_MAX_CHAPTERS } from '../dossier/dossier.constants';
import { FinalChapter, FinalFinding, finalCodeCheck } from '../final-check/final-check-code';
import {
  FINAL_CHECK_NO_COMPLIANT_PROVIDER,
  FINAL_CHECK_STAGE,
  FINAL_FINDING_CODES,
} from '../final-check/final-check.constants';
import {
  anchoredIssues,
  FINAL_CHECK_SHAPE,
  finalCheckAnswerOf,
  finalCheckFailed,
  finalCheckInputOf,
  finalCheckRequest,
} from '../final-check/final-check.prompts';
import {
  finalCheckBypassed,
  FinalCheckChapter,
  FinalCheckState,
  finalCheckStateJson,
  finalCheckStateOf,
} from '../final-check/final-check-state';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { checkMetadata, MetadataResult } from '../metadata/metadata-check';
import {
  METADATA_ATTEMPTS_MAX,
  METADATA_INVALID,
  METADATA_NO_COMPLIANT_PROVIDER,
  METADATA_STAGE,
  METADATA_TOO_LONG,
} from '../metadata/metadata.constants';
import {
  MetadataState,
  metadataFailures,
  metadataRemarks,
  metadataSourceHash,
  metadataStateJson,
  metadataStateOf,
} from '../metadata/metadata-state';
import { callMetadata, metadataInputOf, metadataSourceFields } from '../metadata/metadata-step';
import { mergeFindings } from './glossary-findings';
import { runStageModels, StageModels } from './run-models';
import { runTaskInput } from './translation-run.service';
import {
  RUN_CHAPTER_CHUNKS_MAX,
  CHUNK_CLOSED_STATUSES,
  CHUNK_INVALID_RESPONSE,
  CHUNK_STATUS_UNEXPECTED,
  CHUNK_TOO_LONG,
  RUN_LANGUAGE_UNFINISHED,
  RUN_LANGUAGES_MAX,
  RUN_TX_OPTIONS,
  FINAL_CODE_TX_OPTIONS,
} from './translation-run.constants';
import { StaleClosure, staleClosure } from './stale-closure';

type RunRow = TranslationRun & { operation: Pick<LlmOperation, 'settingsSnapshot'> };
type LanguageRow = TranslationRunLanguage & { run: RunRow };
/** Кусок без ответа модели: шаги читают главу целиком, ответ нужен одному шагу находок. */
type ChunkRow = Omit<TranslationChunk, 'rawResponse'>;

const CLOSED = new Set<TranslationChunk['status']>(CHUNK_CLOSED_STATUSES);
/** Тупиковые причины паузы запуска: выход - отмена или новый запуск (Р13). */
const UNRESUMABLE: readonly LlmPauseReason[] = ['DOSSIER_STALE'];
/** Сброс остановки языка: «продолжить» и готовый контекст. */
const CLEAR_STOP = {
  reason: null,
  reasonText: null,
  reasonModels: [],
  blockedByOperationId: null,
};
/**
 * Статус, до которого ветка шага дойти не может: закрытый кусок отбирает `CLOSED`. Параметр -
 * ровно закрытые статусы: новый статус схемы без своей ветки в `chapterStep` - ошибка сборки.
 */
function assertClosed(status: 'done' | 'flagged'): void {
  void status;
}

/**
 * Причина языка на паузе `NO_COMPLIANT_PROVIDER` по этапу: выход - ключ этого этапа в `stageModels`,
 * а не `translate`. Стыки моделью - этап `check_semantic` (решение арбитра `F05 | F05-6`, 6c В4).
 */
const NO_PROVIDER_REASONS: Readonly<Record<string, string>> = {
  [CHECK_SEMANTIC_STAGE]: CHECK_NO_COMPLIANT_PROVIDER,
  [METADATA_STAGE]: METADATA_NO_COMPLIANT_PROVIDER,
  [FINAL_CHECK_STAGE]: FINAL_CHECK_NO_COMPLIANT_PROVIDER,
};

/** Под замком строки операции черновик уже есть: тупик Р13 не ставится, смена причины откатывается. */
class StaleDecisionChangedError extends Error {}

function runLanguageIdOf(task: LlmTask): string | null {
  const id = (task.payload as Record<string, unknown> | null)?.runLanguageId;
  return typeof id === 'string' ? id : null;
}

function stageModelsOf(run: RunRow, stage: string): StageModels {
  return runStageModels(run.operation.settingsSnapshot, run.stageModels, stage);
}

/**
 * Прибавка к стоимости куска (решение арбитра `F05 | F05-5`: сумма всех платных ответов
 * куска, В7). Пустая колонка - первая стоимость: `increment` по `NULL` дал бы `NULL`.
 */
function costAdded(
  current: Prisma.Decimal | null,
  add: Prisma.Decimal | string,
): Prisma.Decimal | { increment: Prisma.Decimal | string } {
  return current === null ? new Prisma.Decimal(add) : { increment: add };
}

/**
 * Шаги языка запуска перевода (`F05-4`, шаги 4-6). Шаг за раз: досье и глоссарий (запуск -
 * ждущий, Р20) → глава по порядку: сверка отпечатка, нарезка по стыку за шаг → кусок по
 * порядку: перевод → проверки (`F05-5`: механика кодом, Jev, сверка смысла моделью другого
 * семейства) → находки в глоссарий → следующий. Провал проверки - перевод заново с замечаниями,
 * вторая неудача - флаг (`CHECK_FAILURES_MAX`). Модели этапов - из снимка операции запуска или
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
    private readonly drafts: TranslationDraftService,
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
    const open = run.languages.filter((l) =>
      (RUN_LANGUAGE_UNFINISHED as readonly string[]).includes(l.status),
    );
    // Тупик Р13 - только если ни у одного языка нет живого черновика (`staleClosure`). Снимок
    // здесь - лишь повод попробовать тупик: решение принимается заново в транзакции смены
    // причины, под замком строки операции (её `UPDATE`). Черновик появился между снимком и
    // замком - смены нет (откат), «продолжить» идёт дальше. Иначе задачи ставятся всем открытым
    // языкам, а устаревшие закрывает `onResumed` - то же решение в транзакции «продолжить»;
    // задача закрытого языка ничего не делает (`run`: язык не в работе).
    if (
      run.dossierFingerprint !== null &&
      !staleClosure(open).hasLiveDraft &&
      (await this.isStale(run))
    ) {
      try {
        await this.tasks.repauseOperation(op.id, 'DOSSIER_STALE', async (tx) => {
          if ((await this.closeOnStale(tx, run.id)).hasLiveDraft)
            throw new StaleDecisionChangedError();
          await tx.translationRunLanguage.updateMany({
            where: { runId: run.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
            data: { ...CLEAR_STOP, reason: 'DOSSIER_STALE' },
          });
        });
        return [];
      } catch (error) {
        if (!(error instanceof StaleDecisionChangedError)) throw error;
      }
    }
    // Все языки доделаны, а операция на паузе (пауза пришла вместе с последним шагом): шаг
    // любого языка закроет операцию.
    const languages = open.length > 0 ? open : run.languages.slice(0, 1);
    return languages.map((l) => runTaskInput(l.id, l.language, op.id));
  }

  /** «Продолжить»: причины остановки недоделанных языков сбрасываются той же транзакцией. */
  async onResumed(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    // Строка операции уже под замком записи «продолжить» (`resumeOperation`): решение и его
    // исполнение - через `tx`, тем же снимком, что и шаги, которые ждут этот замок.
    const run = await tx.translationRun.findUnique({ where: { operationId: op.id } });
    if (run && run.dossierFingerprint !== null && (await this.isStale(run, tx))) {
      const decision = await this.closeOnStale(tx, run.id);
      // Живого черновика под замком уже нет (его удалили после снимка `resumeTasks`), а языки
      // ждут: продолжать их по устаревшему исходнику нельзя (Р13) - отказ, транзакция откатывается,
      // следующее «продолжить» поставит тупик.
      if (!decision.hasLiveDraft && decision.waiting.length > 0) {
        throw llmTaskConflict(
          'LLM_OPERATION_NOT_RESUMABLE',
          'The source changed and no language writes a draft: the run cannot be continued',
        );
      }
    }
    await tx.translationRunLanguage.updateMany({
      where: { run: { operationId: op.id }, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
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
      where: { run: { operationId: op.id }, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
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
          where: {
            run: { operationId: task.operationId },
            status: { in: [...RUN_LANGUAGE_UNFINISHED] },
          },
          data: { status: 'failed' },
        });
      });
      return { kind: 'done' };
    }
    if (!(RUN_LANGUAGE_UNFINISHED as readonly string[]).includes(lang.status)) {
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
    // Черновик создан - дальше только его главы: шаги перевода и сборки исходник уже не сверяют
    // (правка исходника после создания версии не ставит язык на `DOSSIER_STALE`, 6b).
    // Удалённый черновик (`draftCreatedAt` без ссылки) - туда же: `DRAFT_DELETED` раньше сверок глав.
    const metadata =
      lang.bookVersionId === null && lang.draftCreatedAt === null
        ? null
        : metadataStateOf(lang.metadata)?.result;
    if (metadata) return this.draftStep(lang, ctx, metadata);
    if (lang.chapterNumber === null) return this.startChapter(lang, null, ctx);
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

  /** Глава после `after` по порядку номеров; нет - сборка глав (`F05-6`). */
  private async startChapter(
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
    if (!next) return this.assemblyStep(lang, ctx);
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
    if (!next) return this.startChapter(lang, number, ctx);
    if (next.status === 'checked') return this.applyFindings(lang, next.id, ctx);
    const layout = splitChapter(chapter.content);
    if (next.status === 'translated') return this.checkStep(lang, layout, next, ctx);
    // В перевод - только `pending`: закрытые куски отобраны выше (`CLOSED`), а новый статус
    // схемы без своей ветки не соберётся (`assertClosed`) - иначе он ушёл бы в перевод, который
    // пишется только из `pending`, и шаг платил бы по кругу.
    if (next.status !== 'pending') {
      // Итог `fail` исполнитель на паузу не переводит (`onFailed` не зовётся) - пауза ставится
      // здесь, иначе операция осталась бы `active` без задач.
      assertClosed(next.status);
      return this.stopRun(lang, 'STEP_FAILED', { reason: CHUNK_STATUS_UNEXPECTED });
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
    const { dossier, glossary } = await this.contextOf(lang);
    const verdict = verdictOf(chunk.verdict);
    const previous = lastTranslated(
      doneRunBefore(
        chunks.map((c) => ({
          chunkIndex: c.chunkIndex,
          done: c.status === 'done',
          blocks: (c.blocks ?? []) as unknown as TranslatedBlock[],
        })),
        chunk.chunkIndex,
      ),
    );
    const input = pieceInput({
      layout,
      chunks: chunks.map((c) => ({
        firstBlock: c.firstBlock,
        lastBlock: c.lastBlock,
        words: c.words,
      })),
      index: chunk.chunkIndex,
      dossier,
      glossary,
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      chapterNumber: number,
      previousTail: previous ? tailOf(previous) : null,
    });
    // Перевод заново после провала проверки - с замечаниями проверяющего (решение арбитра
    // `F05 | F05-5`); сид и счётчик неудач остаются в вердикте.
    if (verdict && verdict.remarks.length > 0) input.reviewerRemarks = verdict.remarks;
    const models = stageModelsOf(run, TRANSLATE_STAGE);
    let piece: PieceTranslation;
    try {
      piece = await translatePiece(this.llm, run.operationId, input, layout, ctx, models);
    } catch (error) {
      if (error instanceof LlmError && error.code === 'LLM_NO_COMPLIANT_PROVIDER') {
        return this.pauseNoProvider(lang, TRANSLATE_STAGE, models);
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
        return this.flagChunk(lang, chunk, CHUNK_TOO_LONG, { from: 'pending' });
      case 'invalid':
        // Перевод заново после провала проверки - попытка в вердикт: его стоимость сходится с куском.
        // Ответ не по форме - модель неизвестна (`translatedBy` пустой), есть только стоимость.
        verdict?.attempts.push({
          translatedBy: '',
          translateCostUsd: piece.costUsd.toString(),
          outcome: 'invalid',
        });
        return this.flagChunk(lang, chunk, CHUNK_INVALID_RESPONSE, {
          from: 'pending',
          costUsd: piece.costUsd,
          attempt: true,
          ...(verdict ? { verdict } : {}),
        });
      case 'translated': {
        // Попытка - новая строка вердикта: проверки пишут в неё, сумма куска растёт (В7).
        const next = verdict ?? emptyVerdict(chunk.id);
        next.attempts.push({
          translatedBy: piece.model,
          translateCostUsd: piece.costUsd.toString(),
        });
        await this.prisma.translationChunk.updateMany({
          where: { id: chunk.id, status: 'pending' },
          data: {
            status: 'translated',
            attempts: { increment: 1 },
            rawResponse: piece.raw as Prisma.InputJsonValue,
            blocks: piece.blocks as unknown as Prisma.InputJsonValue,
            model: piece.model,
            callId: piece.callId,
            costUsd: costAdded(chunk.costUsd, piece.costUsd),
            verdict: verdictJson(next),
          },
        });
        return { kind: 'continue' };
      }
    }
  }

  /** Досье запуска и глоссарий языка - данные перевода и проверок куска. */
  private async contextOf(lang: LanguageRow): Promise<{ dossier: unknown; glossary: unknown }> {
    const [dossier, glossary] = await Promise.all([
      this.prisma.bookDossier.findUnique({
        where: { id: lang.run.dossierId ?? '' },
        select: { data: true },
      }),
      this.prisma.bookGlossary.findUnique({
        where: { id: lang.glossaryId ?? '' },
        select: { data: true },
      }),
    ]);
    return { dossier: dossier?.data ?? null, glossary: glossary?.data ?? null };
  }

  /**
   * Проверки переведённого куска (`F05-5`; `tech.md` §6): механика кодом каждый шаг (она
   * дешёвая и детерминированная), Jev - отдельным шагом с записью ответа, сверка смысла - с записью
   * решения. Каждый платный ответ пишется в кусок вместе со своей стоимостью - повтор шага после
   * падения его не оплачивает. Провал → перевод заново с замечаниями, вторая неудача - флаг.
   */
  private async checkStep(
    lang: LanguageRow,
    layout: ChapterLayout,
    chunk: ChunkRow,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const { run } = lang;
    // Кусок, переведённый до `F05-5` (запуск шёл во время выката): попытка из полей куска.
    const verdict = verdictOf(chunk.verdict) ?? emptyVerdict(chunk.id);
    let attempt = currentAttempt(verdict);
    if (!attempt) {
      attempt = {
        translatedBy: chunk.model ?? '',
        translateCostUsd: (chunk.costUsd ?? new Prisma.Decimal(0)).toString(),
      };
      verdict.attempts.push(attempt);
    }
    const { dossier, glossary } = await this.contextOf(lang);
    const source = chunkBlocks(layout, chunk);
    const translated = (chunk.blocks ?? []) as unknown as TranslatedBlock[];
    const sourceText = pieceTexts(source).sourceText;
    const names = nameEntriesOf(glossaryFor(glossary, dossier, sourceText).entries);
    const mechanical = checkMechanical({
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      source,
      translated,
      glossary: names,
    });
    attempt.mechanical = mechanical;
    // Механика провалилась - платные проверки ответ не изменят: перевод заново без них.
    if (mechanical.failures.length > 0) {
      return this.failCheck(lang, chunk, verdict, attempt, mechanical.failures);
    }

    if (attempt.jev === undefined) {
      const jev = await checkJev(
        this.llm,
        run.operationId,
        pieceTexts(source, translated).translatedText,
        stageModelsOf(run, CHECK_JEV_STAGE),
        ctx,
      );
      await ctx.renewLease();
      attempt.jev = jev;
      if (jev.kind !== 'disabled') {
        // Ответ Jev - в кусок до решения со своей стоимостью: повтор шага его не оплачивает.
        const paid = jev.costUsd;
        await this.prisma.translationChunk.updateMany({
          where: { id: chunk.id, status: 'translated' },
          data: {
            verdict: verdictJson(verdict),
            ...(paid ? { costUsd: costAdded(chunk.costUsd, paid) } : {}),
          },
        });
        return { kind: 'continue' };
      }
    }
    const jevFailed = jevFailure(attempt.jev, lang.language);
    if (jevFailed) return this.failCheck(lang, chunk, verdict, attempt, [jevFailed]);

    const missed = names.filter((n) => mechanical.nameMisses.includes(n.key));
    const input = semanticInputOf({
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      source,
      translated,
      seed: attemptSeed(verdict),
      names: missed,
    });
    const outcome = await checkSemantic(
      this.llm,
      run.operationId,
      input,
      attempt.translatedBy,
      stageModelsOf(run, CHECK_SEMANTIC_STAGE),
      ctx,
    );
    switch (outcome.kind) {
      case 'not_independent':
        attempt.outcome = 'not_independent';
        return this.flagChunk(lang, chunk, CHECK_FLAG_REASONS.NOT_INDEPENDENT, {
          from: 'translated',
          verdict,
        });
      case 'unavailable':
        // Этап выключили или модель потеряла цену посреди запуска (решение арбитра
        // `F05 | F05-5`): перевод заново не поможет - флаг, язык идёт дальше.
        attempt.outcome = 'unavailable';
        return this.flagChunk(lang, chunk, CHECK_FLAG_REASONS.CHECK_STAGE_UNAVAILABLE, {
          from: 'translated',
          verdict,
        });
      case 'no_provider':
        return this.pauseNoProvider(lang, CHECK_SEMANTIC_STAGE, outcome.models);
      case 'too_long':
        // Исходник с переводом не влезает в контекст проверяющего: сверить нечем - флаг, как
        // `CHUNK_TOO_LONG` у перевода, а не отказ шага по кругу.
        attempt.outcome = 'too_long';
        return this.flagChunk(lang, chunk, CHECK_FLAG_REASONS.CHECK_INPUT_TOO_LONG, {
          from: 'translated',
          verdict,
        });
      case 'invalid':
        await ctx.renewLease();
        attempt.semantic = { model: '', costUsd: outcome.costUsd.toString(), answer: null };
        attempt.outcome = 'invalid';
        return this.flagChunk(lang, chunk, CHECK_FLAG_REASONS.CHUNK_CHECK_INVALID_RESPONSE, {
          from: 'translated',
          costUsd: outcome.costUsd,
          verdict,
        });
      case 'answered':
        break;
    }
    await ctx.renewLease();
    attempt.semantic = {
      model: outcome.model,
      costUsd: outcome.costUsd.toString(),
      answer: outcome.answer,
    };
    if (semanticFailed(outcome.answer, missed)) {
      return this.failCheck(
        lang,
        chunk,
        verdict,
        attempt,
        semanticFailures(outcome.answer, missed),
        outcome.costUsd,
      );
    }
    attempt.outcome = 'pass';
    await this.prisma.translationChunk.updateMany({
      where: { id: chunk.id, status: 'translated' },
      data: {
        status: 'checked',
        verdict: verdictJson(verdict),
        costUsd: costAdded(chunk.costUsd, outcome.costUsd),
      },
    });
    return { kind: 'continue' };
  }

  /**
   * Неудача проверки: замечания - в вердикт, кусок - в перевод заново (`pending`); неудача
   * `CHECK_FAILURES_MAX` - флаг с кодом первой причины, язык идёт дальше. Находки глоссария
   * у флага не применяются (решение арбитра `F05 | F05-5`).
   */
  private async failCheck(
    lang: LanguageRow,
    chunk: ChunkRow,
    verdict: ChunkVerdict,
    attempt: CheckAttempt,
    failures: readonly CheckFailure[],
    costUsd: Prisma.Decimal | null = null,
  ): Promise<LlmTaskStepResult> {
    attempt.outcome = 'fail';
    verdict.failures += 1;
    verdict.remarks = cappedRemarks(failures.map((f) => f.remark));
    if (verdict.failures >= CHECK_FAILURES_MAX) {
      return this.flagChunk(lang, chunk, failures[0].code, {
        from: 'translated',
        costUsd,
        verdict,
      });
    }
    await this.prisma.translationChunk.updateMany({
      where: { id: chunk.id, status: 'translated' },
      data: {
        status: 'pending',
        verdict: verdictJson(verdict),
        ...(costUsd ? { costUsd: costAdded(chunk.costUsd, costUsd) } : {}),
      },
    });
    return { kind: 'continue' };
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

  /**
   * Ошибка содержания после повторов - флаг куска, язык идёт дальше (`tech.md` §5). `from` -
   * статус, из которого флаг ставится: перевод (`pending`) или проверки (`translated`).
   * `attempt` - шаг перевода, дошедший до модели (у `too_long` вызова не было; вызов проверки
   * попыткой перевода не считается).
   */
  private async flagChunk(
    lang: LanguageRow,
    chunk: ChunkRow,
    reason: string,
    options: {
      from: 'pending' | 'translated';
      costUsd?: Prisma.Decimal | null;
      attempt?: boolean;
      verdict?: ChunkVerdict;
    },
  ): Promise<LlmTaskStepResult> {
    await this.prisma.$transaction(async (tx) => {
      const flagged = await tx.translationChunk.updateMany({
        where: { id: chunk.id, status: options.from },
        data: {
          status: 'flagged',
          flagReason: reason,
          ...(options.costUsd ? { costUsd: costAdded(chunk.costUsd, options.costUsd) } : {}),
          ...(options.attempt ? { attempts: { increment: 1 } } : {}),
          ...(options.verdict ? { verdict: verdictJson(options.verdict) } : {}),
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
   * Сборка глав языка (`F05-6`, 6a; решение арбитра `F05 | F05-6` о дроблении): глава за шаг по
   * порядку номеров исходника, затем этап `metadata`, затем язык доделан (черновик версии - 6b).
   * Перед первой главой - сверка отпечатка исходника: главу, переведённую раньше, могли править,
   * пока переводилась последняя (карточка, «От `F05-4a`»), а её куски уже не сверяются.
   */
  private async assemblyStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    // Глава со стыками на проверке моделью (6c) доделывается раньше следующей.
    const pending = await this.prisma.translationChapter.findFirst({
      where: { runLanguageId: lang.id, status: 'pending' },
      select: CHAPTER_FINDINGS_SELECT,
    });
    if (pending) return this.seamStep(lang, pending, ctx);
    // Главы собираются строго по порядку номеров: следующая - после последней собранной.
    const last = await this.prisma.translationChapter.aggregate({
      where: { runLanguageId: lang.id },
      _max: { chapterNumber: true },
    });
    const after = last._max.chapterNumber;
    const next = await this.prisma.chapter.findFirst({
      where: {
        bookVersionId: lang.run.bookVersionId,
        ...(after === null ? {} : { number: { gt: after } }),
      },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    if (!next) return this.finalCheckStep(lang, ctx);
    if (after === null && (await this.isStale(lang.run))) return this.pauseStale(lang);
    return this.assembleChapterStep(lang, next.number, ctx);
  }

  /**
   * Сборка одной главы (`F05-6`, шаги 2-3, стыки кодом). Строка главы и счётчик флагов - одной
   * транзакцией; повтор шага строку не дублирует (`skipDuplicates`) и флаг второй раз не считает.
   * Собранная глава из нескольких кусков - `pending`: её стыки читает модель (`seamStep`), затем
   * `assembled` (решение арбитра `F05 | F05-6`, 6c В4).
   */
  private async assembleChapterStep(
    lang: LanguageRow,
    number: number,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const input = await chapterAssemblyInput(this.prisma, lang.run.bookVersionId, lang.id, number);
    // Главу удалили, добавили или правили после нарезки - перевод собран не с того исходника.
    if (!input) return this.pauseStale(lang);
    const result = assembleTranslatedChapter(splitChapter(input.content), input.chunks);
    const status =
      result.status === 'assembled' && input.chunks.length > 1 ? 'pending' : result.status;
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      const created = await tx.translationChapter.createMany({
        data: [
          {
            runLanguageId: lang.id,
            chapterNumber: number,
            status,
            flagReason: result.flagReason,
            length: result.length,
            lengthLimit: RICH_HTML_MAX_LENGTH.body,
            seamIndex: result.status === 'assembled' ? result.seamIndex : null,
            findings: result.findings as unknown as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0 && result.flagReason !== null) {
        await tx.translationRunLanguage.update({
          where: { id: lang.id },
          data: { flaggedChapters: { increment: 1 } },
        });
      }
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Стык главы моделью (`F05-6`, шаг 3; решение арбитра `F05 | F05-6`, 6c В4): стык за шаг, этап
   * `check_semantic` со своим промптом, модели - другого семейства, чем модели обоих кусков стыка.
   * Оплаченный ответ - находкой главы до решения: повтор шага его не оплачивает. Все стыки
   * разобраны - глава `assembled`, провал - флаг с номером стыка, не повтор.
   */
  private async seamStep(
    lang: LanguageRow,
    row: ChapterFindingsRow,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const { run } = lang;
    const input = await chapterAssemblyInput(
      this.prisma,
      run.bookVersionId,
      lang.id,
      row.chapterNumber,
    );
    if (!input) return this.pauseStale(lang);
    const seam = nextSeam(input.chunks.length, row.findings);
    if (seam === null) {
      // Находки уже на главе: дописывать нечего, флаг и номер стыка - из них.
      await this.prisma.$transaction(async (tx) => {
        await addChapterFindings(tx, lang.id, row, [], {
          data: { status: 'assembled' },
          where: { status: 'pending' },
          flagFrom: seamFindingsOf(row.findings),
        });
      }, RUN_TX_OPTIONS);
      return { kind: 'continue' };
    }
    const [previous, next] = [input.chunks[seam - 1], input.chunks[seam]];
    const models = stageModelsOf(run, CHECK_SEMANTIC_STAGE);
    const outcome = await callIndependent(
      this.llm,
      run.operationId,
      CHECK_SEMANTIC_STAGE,
      seamRequest(
        seamInputOf(splitChapter(input.content), previous, next, {
          sourceLanguage: run.sourceLanguage,
          targetLanguage: lang.language,
        }),
      ),
      SEAM_SHAPE,
      seamAnswerOf,
      translatorsOf([previous, next]),
      models,
      ctx,
    );
    let finding: SeamFinding;
    switch (outcome.kind) {
      case 'no_provider':
        return this.pauseNoProvider(lang, CHECK_SEMANTIC_STAGE, outcome.models);
      case 'not_independent':
        finding = { code: SEAM_FINDING_CODES.SEAM_NOT_INDEPENDENT, seam };
        break;
      case 'unavailable':
        finding = { code: SEAM_FINDING_CODES.SEAM_CHECK_UNAVAILABLE, seam };
        break;
      case 'too_long':
        finding = { code: SEAM_FINDING_CODES.SEAM_CHECK_INPUT_TOO_LONG, seam };
        break;
      case 'invalid':
        finding = {
          code: SEAM_FINDING_CODES.SEAM_CHECK_INVALID_RESPONSE,
          seam,
          costUsd: outcome.costUsd.toString(),
        };
        break;
      case 'answered':
        finding = seamFailed(outcome.answer)
          ? {
              code: SEAM_FINDING_CODES.SEAM_BROKEN,
              seam,
              model: outcome.model,
              costUsd: outcome.costUsd.toString(),
              problems: seamProblems(outcome.answer),
            }
          : {
              code: SEAM_FINDING_CODES.SEAM_CHECKED,
              seam,
              model: outcome.model,
              costUsd: outcome.costUsd.toString(),
            };
        break;
    }
    // Аренда продлена - шаг ещё наш: ответ стыка пишется, пока глава на проверке стыков; флаг -
    // при закрытии главы, когда разобраны все стыки.
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      await addChapterFindings(tx, lang.id, row, [finding], {
        where: { status: 'pending' },
        flagFrom: [],
      });
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Итоговая проверка (`F05-6`, шаг 5) - после сборки последней главы, до `metadata` (решение
   * арбитра `F05 | F05-6`, 6c В6): кодом один раз, затем моделью глава за шаг. Язык, у которого
   * этап `metadata` начат до неё (запуск шёл во время выката), её не догоняет: в отчёте -
   * «не проводилась».
   */
  private async finalCheckStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const state = finalCheckStateOf(lang.finalCheck);
    if (state?.done || finalCheckBypassed(state, lang.metadata))
      return this.metadataStep(lang, ctx);
    if (!state?.code) return this.finalCodeStep(lang, ctx);
    return this.finalModelStep(lang, state, ctx);
  }

  /** Собранная глава языка без разметки - вход проверок кодом и моделью; `null` - исходник правили. */
  private async assembledChapter(
    lang: LanguageRow,
    number: number,
  ): Promise<{ layout: ChapterLayout; content: string; chunks: InputChunk[] } | null> {
    const input = await chapterAssemblyInput(this.prisma, lang.run.bookVersionId, lang.id, number);
    if (!input) return null;
    const layout = splitChapter(input.content);
    const assembly = assembleTranslatedChapter(layout, input.chunks);
    if (assembly.status !== 'assembled') return null;
    return { layout, content: assembly.content, chunks: input.chunks };
  }

  /**
   * Итоговая проверка кодом: главы исходника ↔ главы перевода, пустые, прогон глоссария по всему
   * тексту (6c В7). Три выборки на весь язык - главы исходника, строки глав и куски, - без запроса
   * на главу. Находки глав и состояние языка - одной транзакцией под замком строки языка: шаг,
   * повторённый после потерянной аренды, видит записанный `code` и находки второй раз не пишет.
   */
  private async finalCodeStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const [sources, rows, chunks] = await Promise.all([
      this.prisma.chapter.findMany({
        where: { bookVersionId: lang.run.bookVersionId },
        select: { number: true, content: true },
        orderBy: { number: 'asc' },
        take: DOSSIER_MAX_CHAPTERS,
      }),
      this.prisma.translationChapter.findMany({
        where: { runLanguageId: lang.id },
        select: { ...CHAPTER_FINDINGS_SELECT, status: true },
        orderBy: { chapterNumber: 'asc' },
        take: DOSSIER_MAX_CHAPTERS,
      }),
      this.prisma.translationChunk.findMany({
        where: { runLanguageId: lang.id },
        select: { ...ASSEMBLY_CHUNK_SELECT, chapterNumber: true },
        orderBy: [{ chapterNumber: 'asc' }, { chunkIndex: 'asc' }],
        take: DOSSIER_MAX_CHAPTERS * RUN_CHAPTER_CHUNKS_MAX,
      }),
    ]);
    const byChapter = new Map<number, typeof chunks>();
    for (const c of chunks) {
      const own = byChapter.get(c.chapterNumber);
      if (own) own.push(c);
      else byChapter.set(c.chapterNumber, [c]);
    }
    const rowOf = new Map(rows.map((r) => [r.chapterNumber, r]));
    const chapters: FinalChapter[] = [];
    for (const source of sources) {
      const layout = splitChapter(source.content);
      const sourceBlocks = layout.blocks.filter((b) => b.translatable).length;
      const row = rowOf.get(source.number);
      let text: string | null = null;
      if (row?.status === 'assembled' && sourceBlocks > 0) {
        const own = byChapter.get(source.number) ?? [];
        // Главу правили после сборки - перевод проверялся бы не с того исходника.
        if (!chunksOfChapter(source.content, own)) return this.pauseStale(lang);
        const assembly = assembleTranslatedChapter(layout, own);
        if (assembly.status !== 'assembled') return this.pauseStale(lang);
        text = richHtmlText(assembly.content);
      }
      chapters.push({
        number: source.number,
        text,
        sourceBlocks,
        inTranslation: row !== undefined,
      });
    }
    const { glossary } = await this.contextOf(lang);
    const entries = nameEntriesOf(((glossary ?? {}) as { entries?: unknown[] }).entries ?? []);
    const result = finalCodeCheck(chapters, entries, lang.language);
    const state: FinalCheckState = { code: { missing: result.missing }, chapters: [], done: false };
    await ctx.renewLease();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<Array<{ finalCheck: Prisma.JsonValue }>>`
        SELECT "finalCheck" FROM "TranslationRunLanguage" WHERE "id" = ${lang.id} FOR UPDATE`;
      if (finalCheckStateOf(current[0]?.finalCheck)?.code) return;
      const written = await tx.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { finalCheck: finalCheckStateJson(state) },
      });
      if (written.count === 0) return;
      for (const [number, found] of result.findings) {
        const row = rowOf.get(number);
        if (row) await addChapterFindings(tx, lang.id, row, found);
      }
    }, FINAL_CODE_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Итоговая проверка моделью: начало и конец главы, модель другого семейства, чем модели кусков
   * главы (6c В5). Глава за шаг; ответ - в состояние языка вместе с находкой главы. Отказ всех
   * моделей по политике - пауза этапа; нет независимой, этап недоступен - находка, язык дальше.
   */
  private async finalModelStep(
    lang: LanguageRow,
    state: FinalCheckState,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const done = new Set(state.chapters.map((c) => c.number));
    const row = await this.prisma.translationChapter.findFirst({
      where: {
        runLanguageId: lang.id,
        status: 'assembled',
        ...(done.size > 0 ? { chapterNumber: { notIn: [...done] } } : {}),
      },
      select: CHAPTER_FINDINGS_SELECT,
      orderBy: { chapterNumber: 'asc' },
    });
    if (!row) {
      await this.prisma.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { finalCheck: finalCheckStateJson({ ...state, done: true }) },
      });
      return { kind: 'continue' };
    }
    const assembled = await this.assembledChapter(lang, row.chapterNumber);
    if (!assembled) return this.pauseStale(lang);
    const { run } = lang;
    const translated = assembled.chunks.flatMap(
      (c) => (Array.isArray(c.blocks) ? c.blocks : []) as unknown as TranslatedBlock[],
    );
    const input = finalCheckInputOf({
      layout: assembled.layout,
      translated,
      sourceLanguage: run.sourceLanguage,
      targetLanguage: lang.language,
      chapterNumber: row.chapterNumber,
      context: await this.contextOf(lang),
    });
    let record: FinalCheckChapter;
    let found: FinalFinding[] = [];
    // Глава без текста в исходнике: читать модели нечего (пустая глава перевода, решение арбитра).
    if (input.blocks.length === 0) {
      record = { number: row.chapterNumber, outcome: 'pass', model: '', costUsd: '0' };
    } else if (!translated.some((b) => input.blocks.includes(b.n) && b.text.trim() !== '')) {
      // Перевод пуст - флаг `CHAPTER_EMPTY` уже поставила проверка кодом; за чтение пустоты не платим.
      record = { number: row.chapterNumber, outcome: 'empty', model: '', costUsd: '0' };
    } else {
      const outcome = await callIndependent(
        this.llm,
        run.operationId,
        FINAL_CHECK_STAGE,
        finalCheckRequest(input),
        FINAL_CHECK_SHAPE,
        finalCheckAnswerOf,
        translatorsOf(assembled.chunks),
        stageModelsOf(run, FINAL_CHECK_STAGE),
        ctx,
      );
      const base = { number: row.chapterNumber, model: '', costUsd: '0' };
      switch (outcome.kind) {
        case 'no_provider':
          return this.pauseNoProvider(lang, FINAL_CHECK_STAGE, outcome.models);
        case 'not_independent':
          record = { ...base, outcome: 'not_independent' };
          found = [{ code: FINAL_FINDING_CODES.FINAL_NOT_INDEPENDENT }];
          break;
        case 'unavailable':
          record = { ...base, outcome: 'unavailable' };
          found = [{ code: FINAL_FINDING_CODES.FINAL_CHECK_UNAVAILABLE }];
          break;
        case 'too_long':
          record = { ...base, outcome: 'too_long' };
          found = [{ code: FINAL_FINDING_CODES.FINAL_CHECK_INPUT_TOO_LONG }];
          break;
        case 'invalid':
          record = { ...base, outcome: 'invalid', costUsd: outcome.costUsd.toString() };
          found = [
            {
              code: FINAL_FINDING_CODES.FINAL_CHECK_INVALID_RESPONSE,
              costUsd: record.costUsd,
            },
          ];
          break;
        case 'answered': {
          const paid = { model: outcome.model, costUsd: outcome.costUsd.toString() };
          const failed = finalCheckFailed(outcome.answer, input.blocks);
          record = { ...base, ...paid, outcome: failed ? 'fail' : 'pass' };
          const issues = anchoredIssues(outcome.answer, input.blocks);
          found = !failed
            ? [{ code: FINAL_FINDING_CODES.FINAL_CHECKED, ...paid }]
            : issues.length > 0
              ? issues.map((i) => ({
                  code: FINAL_FINDING_CODES.FINAL_CHECK_FAIL,
                  block: i.block,
                  issue: i.problem,
                  ...paid,
                }))
              : [{ code: FINAL_FINDING_CODES.FINAL_CHECK_FAIL, ...paid }];
          break;
        }
      }
    }
    // Аренда продлена - шаг ещё наш: ответ пишется без условия на прочитанное состояние, иначе
    // запись мимо теряла бы оплаченный ответ (как у `metadata`).
    await ctx.renewLease();
    const next: FinalCheckState = { ...state, chapters: [...state.chapters, record] };
    await this.prisma.$transaction(async (tx) => {
      const written = await tx.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { finalCheck: finalCheckStateJson(next) },
      });
      if (written.count > 0 && found.length > 0) {
        await addChapterFindings(tx, lang.id, row, found, { where: { status: 'assembled' } });
      }
    }, RUN_TX_OPTIONS);
    return { kind: 'continue' };
  }

  /**
   * Этап `metadata` (`F05-6`, шаг 4): название, описание, автор и названия глав на целевом языке.
   * Ответ с попыткой пишется в язык до решения - повтор шага его не оплачивает. Провал проверок -
   * повтор с замечаниями, вторая неудача - `failed` языка (`METADATA_INVALID`). Перед вызовом -
   * сверка отпечатка: названия глав входят в него, за устаревший вход не платим.
   */
  private async metadataStep(lang: LanguageRow, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const state: MetadataState = metadataStateOf(lang.metadata) ?? { attempts: [], result: null };
    if (state.result) return this.draftStep(lang, ctx, state.result);
    if (metadataFailures(state) >= METADATA_ATTEMPTS_MAX) {
      return this.failLanguage(lang, METADATA_INVALID);
    }
    if (await this.isStale(lang.run)) return this.pauseStale(lang);
    const fields = await metadataSourceFields(
      this.prisma,
      lang.run.bookVersionId,
      lang.run.sourceLanguage,
    );
    if (!fields) return this.pauseStale(lang);
    const { input, source } = metadataInputOf(
      { ...fields, targetLanguage: lang.language },
      await this.contextOf(lang),
      metadataRemarks(state),
    );
    const models = stageModelsOf(lang.run, METADATA_STAGE);
    const outcome = await callMetadata(this.llm, lang.run.operationId, input, ctx, models);
    let failed = false;
    switch (outcome.kind) {
      case 'too_long':
        return this.failLanguage(lang, METADATA_TOO_LONG);
      case 'no_provider':
        return this.pauseNoProvider(lang, METADATA_STAGE, outcome.models);
      case 'invalid':
        // Ответ не по форме и после повтора с замечанием внутри вызова (`METADATA_REMARKS`) -
        // это и есть повтор карточки: ещё один круг заплатил бы снова без замечаний проверки.
        state.attempts.push({
          model: '',
          costUsd: outcome.costUsd.toString(),
          outcome: 'invalid',
          remarks: [],
        });
        failed = true;
        break;
      case 'answered': {
        const checked = checkMetadata(source, outcome.answer);
        state.attempts.push({
          model: outcome.model,
          costUsd: outcome.costUsd.toString(),
          outcome: checked.ok ? 'pass' : 'fail',
          remarks: checked.ok ? [] : checked.remarks,
        });
        if (checked.ok) {
          state.result = checked.result;
          // Снимок полей, с которых переведено: черновик сверит его под замком (6c В1).
          state.sourceHash = metadataSourceHash(fields);
        }
        break;
      }
    }
    // Аренда продлена - шаг ещё наш (`renewLease` бросает, если её забрали): ответ пишется без
    // условия на прочитанную строку, иначе запись мимо (строку тронул «продолжить») теряла бы
    // оплаченный ответ и платила бы за него снова.
    await ctx.renewLease();
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { metadata: metadataStateJson(state) },
    });
    return failed ? this.failLanguage(lang, METADATA_INVALID) : { kind: 'continue' };
  }

  /**
   * Черновик версии и главы (`F05-6`, 6b): версия создаётся один раз, затем глава за шаг по
   * порядку номеров; после последней язык доделан. Исходник после создания версии уже не сверяется
   * на уровне языка - глава сверяет свой отпечаток сама (`SOURCE_CHANGED`, язык идёт дальше).
   */
  private async draftStep(
    lang: LanguageRow,
    ctx: LlmTaskContext,
    metadata: MetadataResult,
  ): Promise<LlmTaskStepResult> {
    if (lang.bookVersionId === null) {
      // Черновик создавался, а ссылки нет - его удалили (решение арбитра `F05 | F05-6`).
      if (lang.draftCreatedAt !== null) return this.failLanguage(lang, DRAFT_DELETED);
      if (await this.isStale(lang.run)) return this.pauseStale(lang);
      if (!(await this.drafts.nextToWrite(lang.id))) {
        return this.failLanguage(lang, NO_CHAPTERS_WRITTEN);
      }
      await ctx.renewLease();
      const state = metadataStateOf(lang.metadata);
      const created = await this.drafts.createDraft(lang, metadata, state?.sourceHash);
      if (!created) return this.pauseStale(lang);
      if (created.kind === 'created') return { kind: 'continue' };
      if (created.kind === 'fields_changed') return this.redoMetadata(lang);
      if (created.kind === 'deleted') return this.failLanguage(lang, DRAFT_DELETED);
      // Повтор шага после потерянной аренды: версию создал прошлый исполнитель - она своя.
      if (created.code === CREATE_FROM_RUN_REJECTIONS.VERSION_EXISTS) {
        const own = await this.prisma.translationRunLanguage.findUnique({
          where: { id: lang.id },
          select: { bookVersionId: true },
        });
        if (own?.bookVersionId) return { kind: 'continue' };
      }
      return this.failLanguage(lang, created.code, created.text);
    }
    const next = await this.drafts.nextToWrite(lang.id);
    if (!next) return this.finishLanguage(lang);
    const written = await this.drafts.writeChapter(
      { ...lang, bookVersionId: lang.bookVersionId },
      next,
      metadata.chapterTitles,
      () => ctx.renewLease(),
    );
    // Черновик удалили посреди записи главы - тот же исход, что и между шагами.
    if (written === 'draft_deleted') return this.failLanguage(lang, DRAFT_DELETED);
    return { kind: 'continue' };
  }

  /**
   * Название или описание исходника правили после принятия ответа `metadata` (решение арбитра
   * `F05 | F05-6`, 6c В1): ответ снимается, попытки остаются (принятая в лимит не входит), этап
   * идёт заново с новым входом. Черновик не создан - его транзакция откатилась.
   */
  private async redoMetadata(lang: LanguageRow): Promise<LlmTaskStepResult> {
    const state = metadataStateOf(lang.metadata);
    if (state) {
      await this.prisma.translationRunLanguage.updateMany({
        where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] }, bookVersionId: null },
        data: {
          metadata: metadataStateJson({ attempts: state.attempts, result: null }),
        },
      });
    }
    return { kind: 'continue' };
  }

  /**
   * Отпечаток исходника не совпал с привязанным к запуску (`tech.md` §2а). Досье запуска -
   * той же версии, что запуск (привязка другой не проходит), поэтому сверка - по версии запуска.
   */
  private async isStale(
    run: TranslationRun,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const current = await sourceFingerprint(db, run.bookVersionId);
    return current !== run.dossierFingerprint;
  }

  /**
   * Исполнение `staleClosure` в транзакции под замком строки операции: устаревшие языки без
   * черновика - `failed` `DOSSIER_STALE` (если у кого-то живой черновик), удалённые черновики -
   * `DRAFT_DELETED`; причины прошлых остановок сбрасываются. Языков у запуска не больше пяти.
   */
  private async closeOnStale(tx: Prisma.TransactionClient, runId: string): Promise<StaleClosure> {
    const languages = await tx.translationRunLanguage.findMany({
      where: { runId, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      select: { id: true, bookVersionId: true, draftCreatedAt: true },
      take: RUN_LANGUAGES_MAX,
    });
    const decision = staleClosure(languages);
    const close = async (ids: string[], reason: string) => {
      if (ids.length === 0) return;
      await tx.translationRunLanguage.updateMany({
        where: { id: { in: ids }, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
        data: { ...CLEAR_STOP, status: 'failed', reason },
      });
    };
    await close(decision.stale, 'DOSSIER_STALE');
    await close(decision.deleted, DRAFT_DELETED);
    return decision;
  }

  /**
   * Все модели этапа отказали по политике данных (Р7): пауза `NO_COMPLIANT_PROVIDER` ставится
   * самим шагом - он знает, какие модели передал в вызов, и пишет их языку (решение арбитра
   * `F05 | F05-4a`, В4). Выход - «продолжить» со `stageModels`.
   */
  private async pauseNoProvider(
    lang: LanguageRow,
    stage: string,
    models: StageModels,
  ): Promise<LlmTaskStepResult> {
    const tried = await this.llm.stageCallModels(stage, models);
    // Причина языка называет этап: из паузы сверки смысла выходят ключом `check_semantic`
    // в `stageModels`, а не `translate`.
    return this.stopRun(lang, 'NO_COMPLIANT_PROVIDER', {
      reason: NO_PROVIDER_REASONS[stage] ?? 'LLM_NO_COMPLIANT_PROVIDER',
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

  /**
   * Исходник правили посреди запуска: пауза `DOSSIER_STALE`, выход - отмена или новый запуск (Р13).
   * Пока у другого незавершённого языка есть черновик, пауза операции остановила бы и его - язык
   * закрывается сам (`failed` `DOSSIER_STALE`), черновики дописываются (решение арбитра `F05 | F05-6`).
   */
  private async pauseStale(lang: LanguageRow): Promise<LlmTaskStepResult> {
    let isSelfClosed = false;
    await this.tasks.stopOrRepause(
      lang.run.operationId,
      'DOSSIER_STALE',
      async (tx) => {
        // Язык, который решение закрыло, своей причины не меняет.
        await tx.translationRunLanguage.updateMany({
          where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
          data: { reason: 'DOSSIER_STALE' },
        });
      },
      UNRESUMABLE,
      // Решение - под замком строки операции: черновик, который сейчас создаётся, его ждёт.
      async (tx) => {
        const decision = await this.closeOnStale(tx, lang.runId);
        isSelfClosed = decision.stale.includes(lang.id) || decision.deleted.includes(lang.id);
        return !decision.hasLiveDraft;
      },
    );
    if (!isSelfClosed) return { kind: 'continue' };
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  /**
   * Язык доделан. Недоделанные считаются после записи своего `done`: из двух языков,
   * закончивших одновременно, тот, кто считает позже, видит оба и закрывает операцию.
   */
  private async finishLanguage(lang: LanguageRow): Promise<LlmTaskStepResult> {
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { status: 'done', reason: null },
    });
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  /**
   * Язык не доделать (`F05-6`: `metadata` не прошла повтор, вход не влезает в контекст, черновик
   * не создан - `VERSION_EXISTS`, `CREATE_REJECTED`): `failed`
   * с кодом, прочие языки идут дальше (решение арбитра `F05 | F05-6`, итог языка).
   */
  private async failLanguage(
    lang: LanguageRow,
    reason: string,
    reasonText: string | null = null,
  ): Promise<LlmTaskStepResult> {
    await this.prisma.translationRunLanguage.updateMany({
      where: { id: lang.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
      data: { status: 'failed', reason, reasonText },
    });
    await this.completeIfFinished(lang.run);
    return { kind: 'done' };
  }

  private async completeIfFinished(run: TranslationRun): Promise<void> {
    const open = await this.prisma.translationRunLanguage.count({
      where: { runId: run.id, status: { in: [...RUN_LANGUAGE_UNFINISHED] } },
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
