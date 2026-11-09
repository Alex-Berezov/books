import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContentDraft, LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BOOK_ANALYSIS_TX_OPTIONS, lockBookAnalysis } from '../../book-analysis/book-analysis-lock';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { httpCode, llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { AutostartLink, assertNoLiveRun } from '../autostart/content-autostart.start';
import { startConflict } from '../content-draft/start-conflict';
import { allChapters } from '../chapter-pages';
import {
  DRAFT_DOSSIER_MISSING,
  DRAFT_LIMIT_FACTOR,
  DRAFT_LIMIT_TOO_LOW,
} from '../content-draft/content-draft.constants';
import { ContentDraftService, contextLimits } from '../content-draft/content-draft.service';
import { htmlToParagraphs } from '../content-draft/content-draft.text';
import { DOSSIER_TOO_LONG } from '../dossier/dossier.constants';
import {
  AnalysisAcceptAllDto,
  AnalysisAcceptAllSkippedDto,
  AnalysisWriteDto,
  AnalysisWriteEstimateDto,
  AnalysisWriteStateDto,
  AnalysisWriteValueDto,
} from '../dto/analysis-write-response.dto';
import {
  acceptInTurn,
  regenFieldsOf,
  regenOperationIds,
  RegenOperationState,
  regenOperationStates,
} from '../draft-quality/run-regen';
import {
  ANALYSIS_REMARK_CODES,
  AnalysisRemarkCode,
  DraftRemark,
} from '../draft-quality/text-checks';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  ACCEPT_ALL_SKIP_CODES,
  ANALYSIS_ITEM_NOT_PROPOSED,
  ANALYSIS_ITEM_NOT_REGENERABLE,
  ANALYSIS_ITEM_UNKNOWN,
  ANALYSIS_REGEN_IN_PROGRESS,
  ANALYSIS_WRITE_NOT_READY,
  NOT_REGENERABLE,
  REGENERABLE_STEPS,
} from './analysis-write.constants';
import {
  analysisDataJson,
  AnalysisItem,
  ANALYSIS_TARGETS,
  AnalysisWriteData,
  emptyAnalysisData,
  proposalPrint,
  readAnalysisData,
  regenBase,
  THEMES_STEP,
  withItem,
} from './analysis-write.data';
import { analysisEstimators } from './analysis-estimate';
import { analysisReadyGate, AnalysisWriteFields } from './analysis-write.fields';
import { AnalysisWriteHandler, analysisWriteTaskInput } from './analysis-write.handler';
import {
  analysisPipelineUsd,
  stepAuthors,
  stepInput,
  stepUsd,
  versionBook,
} from './analysis-write.steps';

const KIND = 'analysis_write' as const;

/** Проходов отмены хода, если перегенерацию начинают быстрее, чем отмена её снимает. */
const DISCARD_ATTEMPTS = 3;

/** Порция чтения прежних ходов на старте: выборка в память - с пределом строк, ходы - все. */
const PREVIOUS_BATCH = 100;

/**
 * Порядок «Accept all»: толкования (темы - до героев и цитат, чьи `themeKeys` на них ссылаются),
 * затем герои, затем цитаты (`speakerKey` - на героев), связи тем - последними.
 */
function acceptRank(item: AnalysisItem): number {
  if (item.links) return Number.MAX_SAFE_INTEGER;
  return item.step === THEMES_STEP ? 0 : item.step;
}

/**
 * Ход анализа «Write Analysis» (`F07-1a`; `features/F07-analysis-autofill/tech.md` §5-§6): оценка
 * шагов 1-3, старт с правом хода на блоки под замком анализа и чтение хода. Контекст досье и
 * глоссария и отказы старта - те же, что у хода пересказа и заготовок (`draftContext`).
 * «Accept», «Discard», «Regenerate» блока, «Accept all» и отмена хода - ручки `content-drafts/:id/*`
 * с развилкой по виду строки (`F07-1b`, решение арбитра `F07 | F07-1`, В6); «Continue» - общий
 * `resumeTasks`.
 */
@Injectable()
export class AnalysisWriteService {
  private readonly logger = new Logger(AnalysisWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly drafts: ContentDraftService,
    private readonly fields: AnalysisWriteFields,
    private readonly handler: AnalysisWriteHandler,
  ) {}

  async estimate(versionId: string): Promise<AnalysisWriteEstimateDto> {
    return (await this.estimateOf(versionId)).dto;
  }

  /**
   * Ручной старт: прежний готовый или упавший ход отбрасывается; право хода на блоки - под замком
   * анализа в одной транзакции со строкой хода (`tech.md` §5). Один строящийся ход вида на версию -
   * частичным уникальным индексом (`DRAFT_IN_PROGRESS`).
   *
   * Автозапуск (`autostart`, `F07-3b`; `tech.md` §6 - как `F06-5`): прежние не отбрасываются;
   * неотброшенный ход вида под замком - 409 `AUTOSTART_SKIPPED_EXISTING` (`ready`) или
   * `AUTOSTART_SKIPPED_IN_PROGRESS` (`building`), второй автозапуск того же языка - 409
   * `AUTOSTART_DUPLICATE` уникальным индексом (`L-019`).
   */
  async start(
    versionId: string,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string | null,
    autostart: AutostartLink | null = null,
  ): Promise<AnalysisWriteDto> {
    // Живой ход вида главнее отказов старта (Р9 `F06 | F06-5`): чтение до отказов выбирает исход,
    // под замком транзакции та же проверка повторяется (L-019).
    if (autostart) await assertNoLiveRun(this.prisma, versionId, KIND);
    this.llm.assertEnabled();
    const estimate = await this.estimateOf(versionId);
    if (estimate.dto.dossier?.refusedTooLong) {
      throw llmTaskConflict(
        DOSSIER_TOO_LONG,
        'The dossier summary is too long for the stage model',
      );
    }
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const limit = limitUsd ?? estimate.suggestedLimitUsd;
    if (limit.lt(estimate.contextLimitUsd)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `limitUsd must fit the dossier and glossary built first: at least ${moneyUsd(estimate.contextLimitUsd)}`,
        code: DRAFT_LIMIT_TOO_LOW,
      });
    }
    const opData = await this.llm.operationData({
      kind: 'draft',
      bookVersionId: versionId,
      limitUsd: limit,
      createdById,
      translationRunId: autostart?.translationRunId ?? null,
      contentKind: KIND,
    });
    let id: string;
    const stale: string[] = [];
    try {
      // Ожидание замка анализа идёт в дедлайн транзакции (`L-020`): сроки - те же, что у прочих
      // писателей под этим замком, а не короткие сроки строки заготовки.
      id = await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, versionId);
        if (autostart) await assertNoLiveRun(tx, versionId, KIND);
        else stale.push(...(await discardPrevious(tx, versionId)));
        const { owns, written } = await this.fields.ownership(tx, versionId);
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.contentDraft.create({
          data: {
            bookVersionId: versionId,
            kind: KIND,
            language: estimate.language,
            operationId: op.id,
            dossierId: estimate.run?.dossierId ?? null,
            glossaryId: estimate.run?.glossaryId ?? null,
            translationRunLanguageId: autostart?.translationRunLanguageId ?? null,
            data: analysisDataJson(emptyAnalysisData(owns, written)),
          },
        });
        await this.tasks.enqueue(analysisWriteTaskInput(row, op.id), tx);
        return row.id;
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (error) {
      throw startConflict(error, autostart !== null, KIND);
    }
    // Перегенерации отброшенных ходов - после коммита нового хода, как у пересказа: старт не удался -
    // их оплаченная работа не снята; операция раньше замка анализа (`clearRegenMark`).
    await this.cancelRegens(stale);
    return this.get(id);
  }

  async latest(versionId: string): Promise<AnalysisWriteStateDto> {
    const row = await this.prisma.contentDraft.findFirst({
      where: { bookVersionId: versionId, kind: KIND, status: { not: 'discarded' } },
      include: { operation: true },
      orderBy: { createdAt: 'desc' },
    });
    return { draft: row ? await this.toDto(row) : null };
  }

  async get(id: string): Promise<AnalysisWriteDto> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!row || row.kind !== KIND) throw new NotFoundException('Analysis run not found');
    return this.toDto(row);
  }

  /**
   * Отмена хода (`discard-run`). Порядок замков - как у конца и отмены задачи
   * (`LlmTaskService.stopOperation`: строка операции, затем снятие отметки под замком анализа и
   * строки хода): перегенерации - каждая `cancelOperation` со снятием своей отметки, строящийся ход -
   * `cancelOperation` с `discarded`; затем под замком анализа и строки ход `discarded` - если на нём
   * нет отметки перегенерации, начатой после чтения; есть - следующий проход снимает её тем же
   * порядком (без встречной блокировки). `regenerate` после `discarded` видит не `ready` - 409.
   */
  async discard(id: string): Promise<AnalysisWriteDto> {
    for (let attempt = 0; attempt < DISCARD_ATTEMPTS; attempt++) {
      const row = await this.row(id);
      if (row.status === 'discarded') return this.get(id);
      await this.cancelRegens(regenOperationIds(readAnalysisData(row.data).items));
      if (row.status === 'building') {
        await this.tasks.cancelOperation(row.operationId, async (tx) => {
          await tx.contentDraft.updateMany({
            where: { id, status: 'building' },
            data: { status: 'discarded' },
          });
        });
      }
      const done = await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, row.bookVersionId);
        await tx.$queryRaw`SELECT "id" FROM "ContentDraft" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.contentDraft.findUnique({ where: { id } });
        if (!current) return true;
        // Перегенерация, начатая между чтением и замком: снять её операцию отсюда - встречный порядок.
        if (regenOperationIds(readAnalysisData(current.data).items).length > 0) return false;
        await tx.contentDraft.updateMany({
          where: { id, status: { not: 'discarded' } },
          data: { status: 'discarded' },
        });
        return true;
      }, BOOK_ANALYSIS_TX_OPTIONS);
      if (done) return this.get(id);
    }
    throw llmTaskConflict(
      ANALYSIS_REGEN_IN_PROGRESS,
      'A regeneration keeps starting: discard again',
    );
  }

  /** Перегенерации - каждая своей отменой со снятием отметки (операция раньше замка анализа). */
  private async cancelRegens(operationIds: readonly string[]): Promise<void> {
    for (const operationId of operationIds) {
      await this.tasks.cancelOperation(operationId, (tx) =>
        this.handler.clearRegenMark(operationId, tx),
      );
    }
  }

  /**
   * «Regenerate» блока хода `ready` (`tech.md` §2): своя операция и задача, замечание
   * редактора в промпт автора. Вторая перегенерация того же блока до конца первой - 409.
   */
  async regenerate(
    id: string,
    index: number,
    remark: string | null,
    createdById: string,
  ): Promise<AnalysisWriteDto> {
    const row = await this.row(id);
    const data = readAnalysisData(row.data);
    const item = this.itemOf(row, data, index);
    if (item.regen) {
      throw llmTaskConflict(ANALYSIS_REGEN_IN_PROGRESS, 'This block is being regenerated');
    }
    // Перегенерируются блоки шагов из разрешающего списка; связи тем - не блок ответа: герои и
    // цитаты получают ключи тем при записи; источники - вместе с блоком шага 5 (`F07-2b`).
    if (
      !REGENERABLE_STEPS.includes(item.step) ||
      item.links ||
      NOT_REGENERABLE.includes(item.target)
    ) {
      throw llmTaskConflict(
        ANALYSIS_ITEM_NOT_REGENERABLE,
        'Theme links and sources are not regenerated on their own',
      );
    }
    this.llm.assertEnabled();
    const usd = await this.regenUsd(row, data, item, remark);
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
    const opData = await this.llm.operationData({
      kind: 'draft',
      bookVersionId: row.bookVersionId,
      limitUsd: usd.mul(DRAFT_LIMIT_FACTOR),
      createdById,
      contentKind: KIND,
    });
    const saved = await this.fields.mutate(row, analysisReadyGate, async (current, tx) => {
      const fresh = current.items[index];
      if (!fresh || 'broken' in fresh) throw llmTaskConflict(ANALYSIS_WRITE_NOT_READY, 'Not ready');
      if (fresh.regen) {
        throw llmTaskConflict(ANALYSIS_REGEN_IN_PROGRESS, 'This block is being regenerated');
      }
      const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
      await this.tasks.enqueue(analysisWriteTaskInput(row, op.id, index), tx);
      return withItem(current, index, {
        regen: { operationId: op.id, remark, pending: null, previous: null },
        regenFailedReason: null,
      });
    });
    if (!saved) {
      throw llmTaskConflict(ANALYSIS_WRITE_NOT_READY, 'The analysis run is not ready');
    }
    return this.get(id);
  }

  /** «Accept» предложения: в блок, если блок не меняли после предложения (`tech.md` §5). */
  async accept(id: string, index: number, expectedPrint?: string): Promise<AnalysisWriteDto> {
    const row = await this.row(id);
    const item = this.itemOf(row, readAnalysisData(row.data), index);
    if (item.regen) {
      throw llmTaskConflict(ANALYSIS_REGEN_IN_PROGRESS, 'This block is being regenerated');
    }
    await this.fields.accept(row, index, expectedPrint);
    return this.get(id);
  }

  /** «Discard» предложения: блок анализа не трогается. */
  async discardItem(id: string, index: number): Promise<AnalysisWriteDto> {
    const row = await this.row(id);
    this.itemOf(row, readAnalysisData(row.data), index);
    await this.fields.discardItem(row, index);
    return this.get(id);
  }

  /**
   * Содержимое предложения блока `index` (`GET content-drafts/:id/items/:index`; решение арбитра
   * `F07 | F07-1b`, А): только пока блок - предложение, иначе 409 `ANALYSIS_ITEM_NOT_PROPOSED`;
   * ответ хода его не несёт (Р1).
   */
  async proposal(id: string, index: number): Promise<AnalysisWriteValueDto> {
    const row = await this.row(id);
    const item = this.itemOf(row, readAnalysisData(row.data), index);
    const value = item.outcome === 'proposed' ? valueDto(item) : null;
    if (!value) throw llmTaskConflict(ANALYSIS_ITEM_NOT_PROPOSED, 'The block is not a proposal');
    return value;
  }

  /**
   * «Accept all»: те же правила по одному - толкования, герои, цитаты, связи тем; следующее
   * предложение выбирается по перечитанному ходу: связи, рождённые принятой темой (Б), входят в
   * тот же проход. 409 самого пункта (`ANALYSIS_WRITE_REFUSED`, `ANALYSIS_BLOCK_CHANGED`,
   * `ANALYSIS_REGEN_IN_PROGRESS`) - пункт пропускается и остаётся предложением, проход идёт дальше;
   * обрывает его только 409 хода (ход больше не `ready`) и прочие отказы - с тем, что уже записано
   * (`acceptedIndexes`). Пропущенные пункты с кодом своего 409 уходят в ответ (`skipped`, решение
   * арбитра `F07 | F07-3`, п.7): иначе вкладка не знает, почему пункт остался предложением.
   */
  async acceptAll(id: string): Promise<AnalysisAcceptAllDto> {
    const row = await this.row(id);
    if (row.status !== 'ready') {
      throw llmTaskConflict(ANALYSIS_WRITE_NOT_READY, 'The analysis run is not ready');
    }
    const skipped = new Set<number>();
    const reasons: AnalysisAcceptAllSkippedDto[] = [];
    await acceptInTurn(
      async (accepted) => {
        const next = readAnalysisData((await this.row(id)).data)
          .items.map((item, index) => ({ item, index }))
          .filter(
            ({ item, index }) =>
              item.outcome === 'proposed' &&
              !item.regen &&
              !accepted.includes(index) &&
              !skipped.has(index),
          )
          .sort((a, b) => acceptRank(a.item) - acceptRank(b.item) || a.index - b.index)[0];
        return next?.index ?? null;
      },
      async (index) => {
        try {
          await this.fields.accept(row, index);
          return true;
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          // 409 хода, а не пункта: ход отбросили или он больше не `ready`.
          if ((await this.row(id)).status !== 'ready') {
            // `skipped` - причины пунктов, пропущенных до обрыва: иначе они теряются (T174, п.1).
            throw llmTaskConflict(ANALYSIS_WRITE_NOT_READY, 'The analysis run is not ready', {
              skipped: reasons,
            });
          }
          skipped.add(index);
          const code = httpCode(error);
          const known = ACCEPT_ALL_SKIP_CODES.find((c) => c === code);
          // Пункт уже не предложение (его принял другой запрос) - причины показывать нечего;
          // иной 409 пункта - не из закрытого списка причин: в журнал, чтобы не потерять молча.
          if (known) {
            reasons.push({ index, code: known });
          } else if (code !== ANALYSIS_ITEM_NOT_PROPOSED) {
            this.logger.warn(`Accept all of run ${id}: item ${index} skipped with ${code}`);
          }
          return false;
        }
      },
      { anyHttp: true },
    );
    return { ...(await this.get(id)), skipped: reasons };
  }

  private async row(id: string): Promise<ContentDraft> {
    const row = await this.prisma.contentDraft.findUnique({ where: { id } });
    if (!row || row.kind !== KIND) throw new NotFoundException('Analysis run not found');
    return row;
  }

  private itemOf(row: ContentDraft, data: AnalysisWriteData, index: number): AnalysisItem {
    if (row.status !== 'ready') {
      throw llmTaskConflict(ANALYSIS_WRITE_NOT_READY, 'The analysis run is not ready');
    }
    const item = data.items[index];
    // Заглушка элемента не той формы (`brokenItem`) - не блок хода: ручки его не трогают.
    if (!item || 'broken' in item) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `The analysis run has no block ${index}`,
        code: ANALYSIS_ITEM_UNKNOWN,
      });
    }
    return item;
  }

  /** Оценка перегенерации: шаг блока на всём тексте версии, автор и проверяющая × 2 прохода. */
  private async regenUsd(
    row: ContentDraft,
    data: AnalysisWriteData,
    item: AnalysisItem,
    remark: string | null,
  ): Promise<Prisma.Decimal> {
    const dossier = row.dossierId
      ? await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } })
      : null;
    if (!dossier) throw llmTaskConflict(DRAFT_DOSSIER_MISSING, 'The run dossier is gone');
    const calls = await analysisEstimators(this.llm);
    const context = await this.handler.contextOf(row, dossier.data, data);
    const input = stepInput(item.step, context, versionBook(context), new Map(), {
      target: item.target,
      current: regenBase(item, context.stored),
      remark,
    });
    return stepUsd(stepAuthors(calls)[item.step], calls.review, input, 0);
  }

  /**
   * Оценка шагов 1-3 (`tech.md` §6) по главам версии; досье или глоссария ещё нет - вход сверху
   * потолком их этапов. Версия без текста глав - отказ до досье.
   */
  private async estimateOf(versionId: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true, title: true, author: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    const chapters = (
      await allChapters(this.prisma, versionId, { number: true, title: true, content: true })
    ).filter((c) => htmlToParagraphs(c.content) !== '');
    if (chapters.length === 0) {
      throw llmTaskConflict('SOURCE_HAS_NO_CHAPTERS', 'The version has no chapter text');
    }
    const calls = await analysisEstimators(this.llm);
    const context = await this.drafts.draftContext(versionId, version);
    const state = await this.fields.state(this.prisma, versionId);
    const upperBound = context.dossier === null || context.glossaryLine !== null;
    const extra = upperBound ? await contextUpperChars(this.llm) : 0;
    const usd = analysisPipelineUsd(
      calls,
      {
        language: version.language,
        dossier: context.dossier?.data ?? null,
        glossary: context.glossaryData,
        bookTitle: version.title,
        author: version.author,
        stored: state.stored,
        merged: {},
        chapters,
        otherKeys: '',
      },
      extra,
    );
    const lines = contextLimits(context, usd);
    return {
      suggestedLimitUsd: lines.suggestedLimitUsd,
      contextLimitUsd: lines.contextLimitUsd,
      run: context.run,
      language: version.language,
      dto: {
        dossier: lines.dossier,
        glossary: lines.glossary,
        stageUsd: moneyUsd(usd),
        upperBound,
        suggestedLimitUsd: moneyUsd(lines.suggestedLimitUsd),
      } satisfies AnalysisWriteEstimateDto,
    };
  }

  private async toDto(row: ContentDraft & { operation: LlmOperation }): Promise<AnalysisWriteDto> {
    const data = readAnalysisData(row.data);
    let waitingFor: AnalysisWriteDto['waitingFor'] = null;
    if (row.waitingFor && row.status === 'building') {
      const glossary = await this.prisma.bookGlossary.findUnique({
        where: { id: row.waitingFor },
        select: { id: true },
      });
      waitingFor = glossary ? 'glossary' : 'dossier';
    }
    // Статус и причина паузы перегенераций: одним запросом по идущим операциям.
    const regenOps = await regenOperationStates(this.prisma, regenOperationIds(data.items));
    return {
      id: row.id,
      bookVersionId: row.bookVersionId,
      status: row.status,
      language: row.language,
      failedReason: row.failedReason,
      waitingFor,
      operation: toOperationDto(row.operation),
      stepsTotal: data.stepsTotal,
      owns: ANALYSIS_TARGETS.filter((t) => data.owns[t] === true),
      steps: data.steps.map((s) => ({
        ...s,
        remarks: remarksDto(s.remarks),
        review: reviewDto(s.review),
      })),
      items: data.items.map((item, index) => itemDto(item, index, regenOps)),
      droppedQuotes: data.droppedQuotes,
      droppedSources: data.droppedSources,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

const ANALYSIS_CODES = new Set<string>(ANALYSIS_REMARK_CODES);

/**
 * Замечания в ответ - по перечню кодов хода анализа (А4). Чужой код ход не ставит (полноту
 * перечня держит `analysis-checks.spec.ts`); попади он в данные - в ответ он не идёт, контракт
 * не нарушается.
 */
function remarksDto(remarks: readonly DraftRemark[]) {
  return remarks.filter((r): r is DraftRemark & { code: AnalysisRemarkCode } =>
    ANALYSIS_CODES.has(r.code),
  );
}

function reviewDto(review: AnalysisItem['review']) {
  return review
    ? { kind: review.kind, model: review.kind === 'answered' ? review.model : null }
    : null;
}

const LIST_VALUE_TARGETS = [
  'characters',
  'keyQuotes',
  'style',
  'themes',
  'symbols',
  'misreadings',
  'discussionQuestions',
  'faq',
  'timeline',
  'adaptations',
  'sources',
] as const;

/**
 * Содержимое предложения для `GET items/:index`: ровно одно поле по виду блока; значение не той
 * формы (список вместо текста и наоборот) - `null`.
 */
function valueDto(item: AnalysisItem): AnalysisWriteValueDto | null {
  const value = item.value;
  if (item.outcome !== 'proposed') return null;
  const empty: AnalysisWriteValueDto = {
    text: null,
    characters: null,
    keyQuotes: null,
    style: null,
    themes: null,
    symbols: null,
    misreadings: null,
    discussionQuestions: null,
    faq: null,
    timeline: null,
    adaptations: null,
    sources: null,
    print: proposalPrint(item),
  };
  // Перегенерированный блок шага 5 показывает и источники, которые его «Accept» добавит (`F07-2b`).
  const base = item.pendingSources?.length ? { ...empty, sources: item.pendingSources } : empty;
  const list = LIST_VALUE_TARGETS.find((target) => target === item.target);
  if (list) return Array.isArray(value) ? { ...base, [list]: value } : null;
  return typeof value === 'string' ? { ...base, text: value } : null;
}

function itemDto(
  item: AnalysisItem,
  index: number,
  regenOps: ReadonlyMap<string, RegenOperationState>,
): AnalysisWriteDto['items'][number] {
  return {
    index,
    target: item.target,
    step: item.step,
    verdict: item.verdict,
    remarks: remarksDto(item.remarks),
    review: reviewDto(item.review),
    outcome: item.outcome,
    failedReason: item.failedReason,
    links: item.links,
    regenFailedReason: item.regenFailedReason,
    ...regenFieldsOf(item.regen, regenOps),
  };
}

/**
 * Ручной старт отбрасывает все прежние `ready`/`failed` ходы версии; их перегенерации читаются
 * порциями (выборка в память - с пределом строк) и отменяются после коммита - отдаются наружу.
 */
async function discardPrevious(tx: Prisma.TransactionClient, versionId: string): Promise<string[]> {
  const stale: string[] = [];
  const where: Prisma.ContentDraftWhereInput = {
    bookVersionId: versionId,
    kind: KIND,
    status: { in: ['ready', 'failed'] },
  };
  for (let after: string | null = null; ; ) {
    const page: Array<{ id: string; data: Prisma.JsonValue }> = await tx.contentDraft.findMany({
      where: { ...where, ...(after === null ? {} : { id: { gt: after } }) },
      select: { id: true, data: true },
      orderBy: { id: 'asc' },
      take: PREVIOUS_BATCH,
    });
    stale.push(...page.flatMap((p) => regenOperationIds(readAnalysisData(p.data).items)));
    if (page.length < PREVIOUS_BATCH) break;
    after = page[page.length - 1].id;
  }
  await tx.contentDraft.updateMany({ where, data: { status: 'discarded' } });
  return stale;
}
