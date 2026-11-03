import { HttpException, Injectable, Logger } from '@nestjs/common';
import { LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { httpCode, LlmTaskLeaseLostError } from '../../llm-worker/llm-worker.errors';
import { DRAFT_IN_PROGRESS } from '../content-draft/content-draft.constants';
import { runLanguageIdOf } from '../run/run-step-support.service';
import { SummaryWriteService } from '../summary-write/summary-write.service';
import {
  AUTOSTART_DUPLICATE,
  AUTOSTART_SKIP_REASONS,
  AUTOSTART_SKIPPED_IN_PROGRESS,
  AUTOSTART_SKIPPED_LLM_DISABLED,
  AutostartSkipReason,
} from './content-autostart.constants';

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
 * Задача `content_autostart` (`F06-5`; `features/F06-summary-autofill/tech.md` §4): после коммита
 * `done` языка зовёт старт хода раздела без отбрасывания прежних и закрывает свою операцию сама
 * (решение арбитра `F06 | F06-5`, Р4). LLM не зовёт, резерв бюджета не проходит; повторов на
 * окончательных отказах старта нет.
 */
@Injectable()
export class ContentAutostartHandler {
  private readonly logger = new Logger(ContentAutostartHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: LlmTaskService,
    private readonly summaryWrite: SummaryWriteService,
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
      where: { translationRunLanguageId: lang.id, kind: 'summary_write' },
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
    let outcome: AutostartOutcome = { kind: 'quiet' };
    let code = 'STEP_ERROR';
    try {
      await this.summaryWrite.start(lang.bookVersionId, undefined, op.createdById, {
        translationRunLanguageId: lang.id,
        translationRunId: lang.runId,
      });
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
    if (outcome.kind === 'retry') return this.retry(task.operationId, op.createdAt, code);
    if (outcome.kind === 'fail') {
      await this.fail(task.operationId, lang.id, lang.bookVersionId, outcome.reason);
    } else {
      await this.close(task.operationId, outcome.kind === 'skip' ? outcome.reason : null);
    }
    return { kind: 'done' };
  }

  /**
   * Временный отказ (решения арбитра `F06 | F06-5`, уточнения В2): повтор через паузу `wait` с кодом,
   * после окна от создания операции - операция `failed` (задача, простоявшая в очереди дольше окна,
   * уходит в `AUTOSTART_FAILED` на первом же временном отказе).
   */
  private async retry(
    operationId: string,
    createdAt: Date,
    code: string,
  ): Promise<LlmTaskStepResult> {
    if (Date.now() - createdAt.getTime() > AUTOSTART_RETRY_WINDOW_MS) {
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
            kind: 'summary_write',
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
