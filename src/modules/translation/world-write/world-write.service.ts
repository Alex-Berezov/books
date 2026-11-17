import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ContentDraft, LlmOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BOOK_ANALYSIS_SELECT, readStoredAnalysis } from '../../book-analysis/book-analysis-data';
import { moneyUsd } from '../../llm/dto/llm-money';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmService } from '../../llm/llm.service';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { LlmTaskService } from '../../llm-worker/llm-task.service';
import { httpCode, llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { allChapters } from '../chapter-pages';
import {
  DRAFT_DOSSIER_MISSING,
  DRAFT_LIMIT_FACTOR,
  DRAFT_LIMIT_TOO_LOW,
  DRAFT_TX_OPTIONS,
} from '../content-draft/content-draft.constants';
import { ContentDraftService, contextLimits } from '../content-draft/content-draft.service';
import { withChapterText } from '../content-draft/content-draft.text';
import { startConflict } from '../content-draft/start-conflict';
import { DOSSIER_TOO_LONG } from '../dossier/dossier.constants';
import {
  acceptInTurn,
  cancelRegens,
  discardPrevious,
  RegenOperationState,
  regenFieldsOf,
  regenOperationIds,
  waitingAndRegens,
} from '../draft-quality/run-regen';
import { DraftRemark, WORLD_REMARK_CODES, WorldRemarkCode } from '../draft-quality/text-checks';
import {
  WorldAcceptAllDto,
  WorldAcceptAllSkippedDto,
  WorldWriteDto,
  WorldWriteEstimateDto,
  WorldWriteStateDto,
  WorldWriteValueDto,
} from '../dto/world-write-response.dto';
import { stageEstimatorFor } from '../llm-model-checks';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  WORLD_ACCEPT_ALL_SKIP_CODES,
  WORLD_ANALYSIS_MISSING,
  WORLD_EXTERNAL_WRITE_STAGE,
  WORLD_ITEM_NOT_PROPOSED,
  WORLD_ITEM_NOT_REGENERABLE,
  WORLD_ITEM_UNKNOWN,
  WORLD_LANGUAGE_UNSUPPORTED,
  WORLD_PAGE_WRITE_STAGE,
  WORLD_REGEN_IN_PROGRESS,
  WORLD_REVIEW_STAGE,
  WORLD_SELECT_STAGE,
  isWorldWriteLanguage,
  WORLD_WRITE_NOT_READY,
} from './world-write.constants';
import {
  emptyWorldData,
  proposalPrint,
  readWorldData,
  stepAt,
  stepsTotalOf,
  withItem,
  WORLD_TEXT_BLOCKS,
  WorldItem,
  WorldWriteData,
  worldDataJson,
} from './world-write.data';
import { worldReadyGate, WorldWriteFields } from './world-write.fields';
import { WorldWriteHandler, worldWriteTaskInput } from './world-write.handler';
import {
  externalInput,
  mainCharacters,
  pageBook,
  pageInput,
  WorldEstimators,
  worldPipelineUsd,
  worldStepUsd,
} from './world-write.steps';

const KIND = 'world_write' as const;

/** Проходов отмены хода, если перегенерацию начинают быстрее, чем отмена её снимает. */
const DISCARD_ATTEMPTS = 3;

/** Оценщики этапов хода мира. */
async function worldEstimators(llm: LlmService): Promise<WorldEstimators> {
  const [select, page, external, review] = await Promise.all([
    stageEstimatorFor(llm, WORLD_SELECT_STAGE),
    stageEstimatorFor(llm, WORLD_PAGE_WRITE_STAGE),
    stageEstimatorFor(llm, WORLD_EXTERNAL_WRITE_STAGE),
    stageEstimatorFor(llm, WORLD_REVIEW_STAGE),
  ]);
  return { select, page, external, review };
}

/**
 * Ход мира «Write World» (`F08-4a`; `features/F08-book-wiki/tech.md` §5): оценка, старт, чтение
 * и решения по пунктам. Контекст досье и глоссария и общие отказы старта - те же, что у ходов
 * пересказа и анализа (`draftContext`); «Accept», «Discard», «Regenerate», «Accept all» и отмена -
 * ручки `content-drafts/:id/*` с развилкой по виду строки, «Continue» - общий `resumeTasks`.
 */
@Injectable()
export class WorldWriteService {
  private readonly logger = new Logger(WorldWriteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly drafts: ContentDraftService,
    private readonly fields: WorldWriteFields,
    private readonly handler: WorldWriteHandler,
  ) {}

  async estimate(versionId: string): Promise<WorldWriteEstimateDto> {
    return (await this.estimateOf(versionId)).dto;
  }

  /**
   * Ручной старт: прежний готовый или упавший ход отбрасывается; один строящийся ход вида на версию -
   * частичным уникальным индексом (`DRAFT_IN_PROGRESS`). Автозапуска у хода мира нет до `F08-9`.
   */
  async start(
    versionId: string,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string,
  ): Promise<WorldWriteDto> {
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
      contentKind: KIND,
    });
    let id: string;
    const stale: string[] = [];
    try {
      id = await this.prisma.$transaction(async (tx) => {
        stale.push(...(await discardPrevious(tx, versionId, KIND)));
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.contentDraft.create({
          data: {
            bookVersionId: versionId,
            kind: KIND,
            language: estimate.language,
            operationId: op.id,
            dossierId: estimate.run?.dossierId ?? null,
            glossaryId: estimate.run?.glossaryId ?? null,
            data: worldDataJson(emptyWorldData()),
          },
        });
        await this.tasks.enqueue(worldWriteTaskInput(row, op.id), tx);
        return row.id;
      }, DRAFT_TX_OPTIONS);
    } catch (error) {
      throw startConflict(error, false, KIND);
    }
    await cancelRegens(this.tasks, this.handler, stale);
    return this.get(id);
  }

  async latest(versionId: string): Promise<WorldWriteStateDto> {
    const row = await this.prisma.contentDraft.findFirst({
      where: { bookVersionId: versionId, kind: KIND, status: { not: 'discarded' } },
      include: { operation: true },
      orderBy: { createdAt: 'desc' },
    });
    return { draft: row ? await this.toDto(row) : null };
  }

  async get(id: string): Promise<WorldWriteDto> {
    const row = await this.prisma.contentDraft.findUnique({
      where: { id },
      include: { operation: true },
    });
    if (!row || row.kind !== KIND) throw new NotFoundException('World run not found');
    return this.toDto(row);
  }

  /**
   * Отмена хода: перегенерации - каждая своей отменой со снятием отметки, строящийся ход - отмена
   * операции с `discarded`; затем под замком строки ход `discarded`, если на нём нет отметки
   * перегенерации, начатой после чтения (её снимает следующий проход).
   */
  async discard(id: string): Promise<WorldWriteDto> {
    for (let attempt = 0; attempt < DISCARD_ATTEMPTS; attempt++) {
      const row = await this.row(id);
      if (row.status === 'discarded') return this.get(id);
      await cancelRegens(
        this.tasks,
        this.handler,
        regenOperationIds(readWorldData(row.data).items),
      );
      if (row.status === 'building') {
        await this.tasks.cancelOperation(row.operationId, async (tx) => {
          await tx.contentDraft.updateMany({
            where: { id, status: 'building' },
            data: { status: 'discarded' },
          });
        });
      }
      const done = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ContentDraft" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.contentDraft.findUnique({ where: { id } });
        if (!current) return true;
        if (regenOperationIds(readWorldData(current.data).items).length > 0) return false;
        await tx.contentDraft.updateMany({
          where: { id, status: { not: 'discarded' } },
          data: { status: 'discarded' },
        });
        return true;
      }, DRAFT_TX_OPTIONS);
      if (done) return this.get(id);
    }
    throw llmTaskConflict(WORLD_REGEN_IN_PROGRESS, 'A regeneration keeps starting: discard again');
  }

  /**
   * «Regenerate» блока хода `ready`: своя операция и задача, замечание редактора в промпт автора.
   * Формы имени не перегенерируются (их пишет выбор героев); вторая перегенерация до конца первой - 409.
   */
  async regenerate(
    id: string,
    index: number,
    remark: string | null,
    createdById: string,
  ): Promise<WorldWriteDto> {
    const row = await this.row(id);
    const data = readWorldData(row.data);
    const item = this.itemOf(row, data, index);
    if (item.regen) {
      throw llmTaskConflict(WORLD_REGEN_IN_PROGRESS, 'This block is being regenerated');
    }
    if (item.block === 'aliases') {
      throw llmTaskConflict(
        WORLD_ITEM_NOT_REGENERABLE,
        'Name forms are not regenerated on their own: they come from the choice of characters',
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
    const saved = await this.fields.mutate(row, worldReadyGate, async (current, tx) => {
      const fresh = current.items[index];
      if (!fresh) throw llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready');
      if (fresh.regen) {
        throw llmTaskConflict(WORLD_REGEN_IN_PROGRESS, 'This block is being regenerated');
      }
      const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
      await this.tasks.enqueue(worldWriteTaskInput(row, op.id, index), tx);
      return withItem(current, index, {
        regen: { operationId: op.id, remark, pending: null, previous: null },
        regenFailedReason: null,
      });
    });
    if (!saved) throw llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready');
    return this.get(id);
  }

  async accept(id: string, index: number, expectedPrint?: string): Promise<WorldWriteDto> {
    const row = await this.row(id);
    const item = this.itemOf(row, readWorldData(row.data), index);
    if (item.regen) {
      throw llmTaskConflict(WORLD_REGEN_IN_PROGRESS, 'This block is being regenerated');
    }
    await this.fields.accept(row, index, expectedPrint);
    return this.get(id);
  }

  async discardItem(id: string, index: number): Promise<WorldWriteDto> {
    const row = await this.row(id);
    this.itemOf(row, readWorldData(row.data), index);
    await this.fields.discardItem(row, index);
    return this.get(id);
  }

  /** Содержимое предложения пункта `index`: только пока он предложение (`WORLD_ITEM_NOT_PROPOSED`). */
  async proposal(id: string, index: number): Promise<WorldWriteValueDto> {
    const row = await this.row(id);
    const item = this.itemOf(row, readWorldData(row.data), index);
    if (item.outcome !== 'proposed') {
      throw llmTaskConflict(WORLD_ITEM_NOT_PROPOSED, 'The block is not a proposal');
    }
    return valueDto(item);
  }

  /**
   * «Accept all»: предложения по одному в порядке пунктов (страница героя - до внешних блоков).
   * 409 самого пункта (`WORLD_WRITE_REFUSED`, `WORLD_BLOCK_CHANGED`, `WORLD_REGEN_IN_PROGRESS`) -
   * пункт пропускается и остаётся предложением с кодом в `skipped`; обрывает проход только 409 хода.
   */
  async acceptAll(id: string): Promise<WorldAcceptAllDto> {
    const row = await this.row(id);
    if (row.status !== 'ready') {
      throw llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready');
    }
    const skipped = new Set<number>();
    const reasons: WorldAcceptAllSkippedDto[] = [];
    await acceptInTurn(
      async (accepted) => {
        const items = readWorldData((await this.row(id)).data).items;
        const next = items.findIndex(
          (item, index) =>
            item.outcome === 'proposed' &&
            !item.regen &&
            !accepted.includes(index) &&
            !skipped.has(index),
        );
        return next < 0 ? null : next;
      },
      async (index) => {
        try {
          await this.fields.accept(row, index);
          return true;
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          if ((await this.row(id)).status !== 'ready') {
            throw llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready', {
              skipped: reasons,
            });
          }
          skipped.add(index);
          const code = httpCode(error);
          const known = WORLD_ACCEPT_ALL_SKIP_CODES.find((c) => c === code);
          if (known) reasons.push({ index, code: known });
          else if (code !== WORLD_ITEM_NOT_PROPOSED) {
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
    if (!row || row.kind !== KIND) throw new NotFoundException('World run not found');
    return row;
  }

  private itemOf(row: ContentDraft, data: WorldWriteData, index: number): WorldItem {
    if (row.status !== 'ready') {
      throw llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready');
    }
    const item = data.items[index];
    if (!item) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `The world run has no block ${index}`,
        code: WORLD_ITEM_UNKNOWN,
      });
    }
    return item;
  }

  /** Оценка перегенерации: шаг пункта на главах героя, автор и проверяющая × 2 прохода. */
  private async regenUsd(
    row: ContentDraft,
    data: WorldWriteData,
    item: WorldItem,
    remark: string | null,
  ): Promise<Prisma.Decimal> {
    const dossier = row.dossierId
      ? await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } })
      : null;
    if (!dossier) throw llmTaskConflict(DRAFT_DOSSIER_MISSING, 'The run dossier is gone');
    const candidate = data.candidates?.find((c) => c.key === item.key);
    if (!candidate) throw llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready');
    const calls = await worldEstimators(this.llm);
    const context = await this.handler.contextOf(row, dossier.data);
    const spec = { block: item.block, current: item.value, remark };
    if (stepAt(item.step).kind === 'external') {
      return worldStepUsd(
        calls.external,
        calls.review,
        externalInput(context, candidate, null, spec),
        calls.page.maxTokens,
      );
    }
    return worldStepUsd(
      calls.page,
      calls.review,
      pageInput(context, candidate, new Map(), pageBook(context, candidate, null), spec),
      0,
    );
  }

  /**
   * Оценка (`tech.md` §5) по числу героев `main` анализа и главам версии; досье или глоссария ещё
   * нет - вход сверху потолком их этапов. Отказы: нет глав, язык не `ru`/`en` (Q5), нет анализа
   * или в нём нет героя `main` (Q4).
   */
  private async estimateOf(versionId: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { language: true, title: true, author: true, originalLanguage: true },
    });
    if (!version) throw new NotFoundException('Book version not found');
    if (!isWorldWriteLanguage(version.language)) {
      throw llmTaskConflict(
        WORLD_LANGUAGE_UNSUPPORTED,
        'Write World takes only ru and en versions for now',
      );
    }
    const analysisRow = await this.prisma.bookAnalysis.findUnique({
      where: { bookVersionId: versionId },
      select: BOOK_ANALYSIS_SELECT,
    });
    const analysis = analysisRow ? readStoredAnalysis(analysisRow) : null;
    const candidates = analysis ? mainCharacters(analysis) : [];
    if (!analysis || candidates.length === 0) {
      throw llmTaskConflict(
        WORLD_ANALYSIS_MISSING,
        'The version has no analysis with a main character: write the analysis first',
      );
    }
    const chapters = withChapterText(
      await allChapters(this.prisma, versionId, { number: true, title: true, content: true }),
    );
    if (chapters.length === 0) {
      throw llmTaskConflict('SOURCE_HAS_NO_CHAPTERS', 'The version has no chapter text');
    }
    const calls = await worldEstimators(this.llm);
    const context = await this.drafts.draftContext(versionId, version);
    const upperBound = context.dossier === null || context.glossaryLine !== null;
    const extra = upperBound ? await contextUpperChars(this.llm) : 0;
    const usd = worldPipelineUsd(
      calls,
      {
        language: version.language,
        dossier: context.dossier?.data ?? null,
        glossary: context.glossaryData,
        bookTitle: version.title,
        author: version.author,
        originalLanguage: version.originalLanguage ?? '',
        chapters,
        analysis,
        entities: new Map(),
        names: { titles: [version.title], authors: [version.author] },
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
        candidates: candidates.length,
        stageUsd: moneyUsd(usd),
        upperBound,
        suggestedLimitUsd: moneyUsd(lines.suggestedLimitUsd),
      } satisfies WorldWriteEstimateDto,
    };
  }

  private async toDto(row: ContentDraft & { operation: LlmOperation }): Promise<WorldWriteDto> {
    const data = readWorldData(row.data);
    const { waitingFor, regenOps } = await waitingAndRegens(
      this.prisma,
      row,
      regenOperationIds(data.items),
    );
    return {
      id: row.id,
      bookVersionId: row.bookVersionId,
      status: row.status,
      language: row.language,
      failedReason: row.failedReason,
      waitingFor,
      operation: toOperationDto(row.operation),
      stepsTotal: stepsTotalOf(data),
      candidates:
        data.candidates?.map((c) => ({
          key: c.key,
          name: c.name,
          aliases: c.aliases,
          chapters: c.mentions.chapters,
        })) ?? null,
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

const WORLD_CODES = new Set<string>(WORLD_REMARK_CODES);

/** Замечания в ответ - по перечню кодов хода мира: чужой код в ответ не идёт. */
function remarksDto(remarks: readonly DraftRemark[]) {
  return remarks.filter((r): r is DraftRemark & { code: WorldRemarkCode } =>
    WORLD_CODES.has(r.code),
  );
}

function reviewDto(review: WorldItem['review']) {
  return review
    ? { kind: review.kind, model: review.kind === 'answered' ? review.model : null }
    : null;
}

/** Содержимое предложения: ровно одно поле по блоку. */
function valueDto(item: WorldItem): WorldWriteValueDto {
  const out: WorldWriteValueDto = {
    text: null,
    aliases: null,
    profile: null,
    arc: null,
    scenes: null,
    relations: null,
    quotes: null,
    faq: null,
    adaptations: null,
    sources: item.sources && item.sources.length > 0 ? item.sources : null,
    print: proposalPrint(item),
  };
  if (WORLD_TEXT_BLOCKS.has(item.block))
    return { ...out, text: typeof item.value === 'string' ? item.value : null };
  return { ...out, [item.block]: item.value ?? null };
}

function itemDto(
  item: WorldItem,
  index: number,
  regenOps: ReadonlyMap<string, RegenOperationState>,
): WorldWriteDto['items'][number] {
  return {
    index,
    key: item.key,
    block: item.block,
    step: item.step,
    verdict: item.verdict,
    remarks: remarksDto(item.remarks),
    review: reviewDto(item.review),
    outcome: item.outcome,
    failedReason: item.failedReason,
    regenFailedReason: item.regenFailedReason,
    ...regenFieldsOf(item.regen, regenOps),
  };
}
