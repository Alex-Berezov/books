import { HttpException, Injectable, Logger } from '@nestjs/common';
import { LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { httpCode, LlmTaskLeaseLostError } from '../../llm-worker/llm-worker.errors';
import { DRAFT_IN_PROGRESS } from '../content-draft/content-draft.constants';
import { runLanguageIdOf } from '../run/run-step-support.service';
import { AnalysisWriteService } from '../analysis-write/analysis-write.service';
import { SummaryWriteService } from '../summary-write/summary-write.service';
import { WORLD_ANALYSIS_MISSING } from '../world-write/world-write.constants';
import { WorldWriteService } from '../world-write/world-write.service';
import {
  AUTOSTART_DUPLICATE,
  AUTOSTART_SKIP_REASONS,
  AUTOSTART_SKIPPED_IN_PROGRESS,
  AUTOSTART_SKIPPED_LLM_DISABLED,
  AutostartKind,
  autostartKindOfTask,
  AutostartSkipReason,
  WORLD_AUTOSTART_WAITS_FOR_ANALYSIS,
} from './content-autostart.constants';
import { AutostartLink, assertNoLiveRun } from './content-autostart.start';

/**
 * Окно повторов временного отказа старта от создания операции автозапуска и пауза между ними
 * (решение арбитра `F06 | F06-5`, уточнение В2 круга /fix): воркер не повторяет задачу на
 * исключении, а `continue` обнуляет счётчик попыток - граница повторов здесь, по возрасту
 * операции. LLM внутри окна не зовётся.
 */
export const AUTOSTART_RETRY_WINDOW_MS = 60 * 60 * 1000;
export const AUTOSTART_RETRY_DELAY_MS = 30_000;

/**
 * Отказы, которые проходят сами: не повод занимать слот строкой `failed` - шаг повторяется
 * в окне `AUTOSTART_RETRY_WINDOW_MS`, после окна операция `failed` (`AUTOSTART_FAILED`).
 */
const TRANSIENT_CODES = new Set(['LLM_MODELS_UNAVAILABLE', 'LLM_TASK_PAIR_BUSY']);

/**
 * Ход анализа версии языка для автозапуска мира (`F08-9b`, решение арбитра `F08 | F08-9b`, Q1, Q3):
 * `wait` - анализ ещё идёт (ход строится, в том числе на паузе, или операция анализа запуска ещё
 * не закрыта); `ready` - готовый ход анализа есть, с момента готовности считается окно повторов;
 * `missing` - готового хода нет и ждать нечего (упал, отброшен, пропущен, не заводился).
 */
type AnalysisRunState = { kind: 'wait' } | { kind: 'ready'; readyAt: Date } | { kind: 'missing' };

/** Неотброшенных ходов анализа версии на чтение: строящийся один (частичный индекс), готовых - единицы. */
const ANALYSIS_RUNS_READ = 5;

/** Старт хода раздела автозапуском (`SummaryWriteService`, `AnalysisWriteService`, `WorldWriteService`). */
interface AutostartWriter {
  start(
    versionId: string,
    limitUsd: undefined,
    createdById: string | null,
    autostart: AutostartLink,
  ): Promise<unknown>;
}

/** Версии больше нет (каскад удаления): стартовать не на чем, отказа нет. */
const VERSION_GONE = 'HTTP_404';

/**
 * Исход отказа старта автозапуска (`tech.md` §4 п.4; решения арбитра `F06 | F06-5`, Р3, Р6):
 * `skip` - операция закрыта с причиной, строка хода не заводится (слот не занят); `fail` - строка
 * хода `failed` с причиной; `retry` - отказ временный, задача повторяется; `quiet` - без причины
 * (второй автозапуск того же языка, версии нет).
 */
export type AutostartOutcome =
  | { kind: 'skip'; reason: AutostartSkipReason }
  | { kind: 'fail'; reason: string }
  | { kind: 'retry' }
  | { kind: 'quiet' };

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** `code` - тело отказа Nest (`httpCode`: без кода - `HTTP_<статус>`). */
export function autostartOutcome(code: string): AutostartOutcome {
  if (code === AUTOSTART_DUPLICATE || code === VERSION_GONE) return { kind: 'quiet' };
  if (code === 'LLM_DISABLED') return { kind: 'skip', reason: AUTOSTART_SKIPPED_LLM_DISABLED };
  // Частичный индекс строящегося хода (`tech.md` §4 п.3-п.4): пропуск, а не «не удалось».
  if (code === DRAFT_IN_PROGRESS) return { kind: 'skip', reason: AUTOSTART_SKIPPED_IN_PROGRESS };
  const skip = AUTOSTART_SKIP_REASONS.find((reason) => reason === code);
  if (skip) return { kind: 'skip', reason: skip };
  if (TRANSIENT_CODES.has(code) || code.startsWith('HTTP_')) return { kind: 'retry' };
  return { kind: 'fail', reason: code };
}

/**
 * Задачи `content_autostart`, `content_autostart_analysis` и `content_autostart_world` (`F06-5`,
 * `F07-3b`, `F08-9b`;
 * `features/F06-summary-autofill/tech.md` §4): после коммита `done` языка зовут старт хода раздела
 * по виду задачи без отбрасывания прежних и закрывают свою операцию сами (решение арбитра
 * `F06 | F06-5`, Р4; вид задачи - `F07 | F07-3b`, /qa круг 1). LLM не зовёт, резерв бюджета
 * не проходит; повторов на окончательных отказах старта нет.
 */
@Injectable()
export class ContentAutostartHandler {
  private readonly logger = new Logger(ContentAutostartHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly summaryWrite: SummaryWriteService,
    private readonly analysisWrite: AnalysisWriteService,
    private readonly worldWrite: WorldWriteService,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    // Сбой, который не снял повтор задачи: операция `failed`, «Continue» ей продолжать нечего.
    onFailed: async (task) => {
      await this.tasks.failOperation(task.operationId);
    },
  };

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const runLanguageId = runLanguageIdOf(task);
    const kind = autostartKindOfTask(task.kind);
    const lang = runLanguageId
      ? await this.prisma.translationRunLanguage.findUnique({
          where: { id: runLanguageId },
          select: { id: true, runId: true, status: true, bookVersionId: true },
        })
      : null;
    // Языка или черновика больше нет (каскад удаления): стартовать не на чем.
    if (!lang || lang.status !== 'done' || lang.bookVersionId === null) {
      await this.close(task.operationId, null);
      return { kind: 'done' };
    }
    // Повтор задачи после старта, который успел закоммитить ход (обрыв до закрытия операции):
    // ход языка уже есть - закрыть без причины, а не записать «ход строится» (L-019: единственность
    // держит индекс, это чтение только выбирает исход).
    const started = await this.prisma.contentDraft.findFirst({
      where: { translationRunLanguageId: lang.id, kind },
      select: { id: true },
    });
    if (started) {
      await this.close(task.operationId, null);
      return { kind: 'done' };
    }
    const op = await this.prisma.llmOperation.findUnique({
      where: { id: task.operationId },
      select: { createdById: true, status: true, createdAt: true },
    });
    // Операцию сняли со страницы операций, пока шаг шёл: хода не стартовать и статус не трогать -
    // `continue` при не `active` операции закрывает задачу `cancelled` (как `LLM_OPERATION_NOT_ACTIVE`).
    if (!op || op.status !== 'active') return { kind: 'continue' };
    // Ход мира - после хода анализа версии языка (решения арбитра `F08 | F08-9b`, Q1, Q3, и
    // `F08 | F08-9b-1`): живой ход мира главнее отказа «нет анализа» (Р9 `F06 | F06-5`); пока
    // анализ идёт - ожидание без счёта окна, окно повторов - от позднего из создания операции
    // и готовности анализа.
    let windowFrom = op.createdAt;
    if (kind === 'world_write') {
      const live = await this.liveRunSkip(lang.bookVersionId);
      if (live) {
        await this.close(task.operationId, live);
        return { kind: 'done' };
      }
      const gate = await this.analysisRunState(lang.runId, lang.bookVersionId);
      if (gate.kind === 'wait') {
        return {
          kind: 'wait',
          reason: WORLD_AUTOSTART_WAITS_FOR_ANALYSIS,
          runAfter: new Date(Date.now() + AUTOSTART_RETRY_DELAY_MS),
        };
      }
      if (gate.kind === 'missing') {
        await this.fail(
          task.operationId,
          lang.id,
          lang.bookVersionId,
          kind,
          WORLD_ANALYSIS_MISSING,
        );
        return { kind: 'done' };
      }
      if (gate.readyAt > windowFrom) windowFrom = gate.readyAt;
    }
    let outcome: AutostartOutcome = { kind: 'quiet' };
    let code = 'STEP_ERROR';
    try {
      const link = { translationRunLanguageId: lang.id, translationRunId: lang.runId };
      await this.writers[kind].start(lang.bookVersionId, undefined, op.createdById, link);
    } catch (error) {
      // Аренда ушла, отказ модуля LLM, остановка процесса - разбирает воркер.
      if (
        error instanceof LlmTaskLeaseLostError ||
        error instanceof LlmError ||
        ctx.signal.aborted
      ) {
        throw error;
      }
      if (error instanceof HttpException) code = httpCode(error);
      // Сбой без HTTP-кода - в журнал именем (текст исключения может нести текст книги).
      else
        this.logger.error(
          `Autostart operation ${task.operationId}: start threw ${errorName(error)}`,
        );
      outcome = error instanceof HttpException ? autostartOutcome(code) : { kind: 'retry' };
    }
    if (outcome.kind === 'retry') return this.retry(task.operationId, windowFrom, code);
    if (outcome.kind === 'fail') {
      await this.fail(task.operationId, lang.id, lang.bookVersionId, kind, outcome.reason);
    } else {
      await this.close(task.operationId, outcome.kind === 'skip' ? outcome.reason : null);
    }
    return { kind: 'done' };
  }

  /** Старт хода по виду раздела: подпись у трёх одна, ссылка на язык и запуск - последней. */
  private get writers(): Record<AutostartKind, AutostartWriter> {
    return {
      summary_write: this.summaryWrite,
      analysis_write: this.analysisWrite,
      world_write: this.worldWrite,
    };
  }

  /**
   * Причина пропуска, если у версии уже есть неотброшенный ход мира (`assertNoLiveRun`): выбирает
   * только исход - единственность держат замок в `start` и P2002 в `fail` (L-019).
   */
  private async liveRunSkip(bookVersionId: string): Promise<AutostartSkipReason | null> {
    try {
      await assertNoLiveRun(this.prisma, bookVersionId, 'world_write');
      return null;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const outcome = autostartOutcome(httpCode(error));
      if (outcome.kind !== 'skip') throw error;
      return outcome.reason;
    }
  }

  /**
   * Ход анализа версии языка (`AnalysisRunState`): ход этого запуска или ручной на той же версии -
   * ручной старт мог опередить автозапуск анализа, и тот закрылся пропуском (`AUTOSTART_SKIPPED_*`).
   * Строящийся (в том числе на паузе) - ждать, готовый - старт; иначе ждать, пока не закрыта
   * операция анализа запуска на версии (автозапуск ещё не завёл ход или стоит на паузе).
   */
  private async analysisRunState(
    translationRunId: string,
    bookVersionId: string,
  ): Promise<AnalysisRunState> {
    const runs = await this.prisma.contentDraft.findMany({
      where: { bookVersionId, kind: 'analysis_write', status: { in: ['building', 'ready'] } },
      select: { status: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
      take: ANALYSIS_RUNS_READ,
    });
    if (runs.some((r) => r.status === 'building')) return { kind: 'wait' };
    const ready = runs.find((r) => r.status === 'ready');
    if (ready) return { kind: 'ready', readyAt: ready.updatedAt };
    const live = await this.prisma.llmOperation.findFirst({
      where: {
        translationRunId,
        bookVersionId,
        kind: 'draft',
        contentKind: 'analysis_write',
        status: { in: ['active', 'paused'] },
      },
      select: { id: true },
    });
    return live ? { kind: 'wait' } : { kind: 'missing' };
  }

  /**
   * Временный отказ (решения арбитра `F06 | F06-5`, уточнения В2): повтор через паузу `wait` с кодом,
   * после окна от `from` - операция `failed` (задача, простоявшая в очереди дольше окна, уходит
   * в `AUTOSTART_FAILED` на первом же временном отказе). `from` - создание операции, у мира -
   * готовность хода анализа (`F08 | F08-9b`, Q1).
   */
  private async retry(operationId: string, from: Date, code: string): Promise<LlmTaskStepResult> {
    if (Date.now() - from.getTime() > AUTOSTART_RETRY_WINDOW_MS) {
      await this.tasks.failOperation(operationId);
      return { kind: 'done' };
    }
    // `wait` пишет код в `lastError` задачи - причину видно на странице операций.
    return {
      kind: 'wait',
      reason: code,
      runAfter: new Date(Date.now() + AUTOSTART_RETRY_DELAY_MS),
    };
  }

  private async close(operationId: string, skipReason: AutostartSkipReason | null): Promise<void> {
    await this.tasks.completeOperation(operationId, async (tx) => {
      if (skipReason === null) return;
      await tx.llmOperation.update({ where: { id: operationId }, data: { skipReason } });
    });
  }

  /**
   * Отказ старта, который вернул бы и ручной старт, - строка хода `failed` с причиной на операции
   * автозапуска (Р6): её видно во вкладке и в истории, ручной старт её отбрасывает. Слот (язык, вид)
   * уже занят - повтор задачи, закрыть без второй строки.
   */
  private async fail(
    operationId: string,
    translationRunLanguageId: string,
    versionId: string,
    kind: AutostartKind,
    reason: string,
  ): Promise<void> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true },
    });
    if (!version) return this.close(operationId, null);
    try {
      await this.tasks.completeOperation(operationId, async (tx) => {
        await tx.contentDraft.create({
          data: {
            bookVersionId: versionId,
            kind,
            status: 'failed',
            failedReason: reason,
            language: version.language,
            operationId,
            translationRunLanguageId,
          },
        });
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      await this.close(operationId, null);
    }
  }
}
