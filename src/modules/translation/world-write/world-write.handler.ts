import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentDraft, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BOOK_ANALYSIS_SELECT,
  EMPTY_BOOK_ANALYSIS,
  readStoredAnalysis,
} from '../../book-analysis/book-analysis-data';
import {
  BOOK_WORLD_PUBLIC_SELECT,
  readAliasChapterExclusions,
  readStoredEntity,
} from '../../book-world/book-world-data';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { WorldMentionCounter, type WorldChapterExclusion } from '../../book-world/world-mentions';
import { worldRolePasses } from '../../book-world/world-public';
import { LlmService } from '../../llm/llm.service';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { LlmTaskContext, LlmTaskHandler, LlmTaskStepResult } from '../../llm-worker/llm-task.types';
import { SourceFetcherService } from '../../source-fetch/source-fetcher.service';
import type { SourceFetchResult } from '../../source-fetch/source-fetch.types';
import { hostOf, PageCheck, sourcesOffline } from '../analysis-write/analysis-write.external';
// Тот же код причины, что у внешнего шага хода анализа: одно значение на оба хода.
import { EXTERNAL_UNVERIFIED } from '../analysis-write/analysis-write.handler';
import { allChapters } from '../chapter-pages';
import {
  DRAFT_DATA_INVALID,
  DRAFT_INPUT_MISSING,
  DRAFT_INVALID_RESPONSE,
  DRAFT_TOO_LONG,
} from '../content-draft/content-draft.constants';
import { ContentDraftService } from '../content-draft/content-draft.service';
import {
  chaptersText,
  htmlToParagraphs,
  withChapterText,
} from '../content-draft/content-draft.text';
import { awaitDraftContext } from '../content-draft/draft-context-wait';
import { DossierDemandService } from '../dossier/dossier-demand.service';
import {
  QualityLoopResult,
  QualityLoopResume,
  runQualityLoop,
} from '../draft-quality/quality-loop';
import { ChapterIndex, indexChapters } from '../draft-quality/quote-check';
import {
  clearRegenMarkOf,
  draftRowOf,
  regenResumeOf,
  runTaskInput,
  runTaskPayload,
} from '../draft-quality/run-regen';
import { failRun, finishRun, RunGone, stepGone } from '../draft-quality/run-steps';
import { DraftRemark } from '../draft-quality/text-checks';
import { pauseOnFailure } from '../pause-by-failure';
import { runStageModels } from '../run/run-models';
import {
  blockOfPath,
  dossierForms,
  externalChecks,
  foldedVersion,
  invalidBlocks,
  verifyWorldExternal,
  WorldExternalDraft,
  WorldExternalVerdict,
  WorldPageDraft,
  WorldSelectDraft,
} from './world-write.checks';
import {
  WORLD_ANALYSIS_MISSING,
  WORLD_REVIEW_STAGE,
  WORLD_WRITE_REFUSED,
  WORLD_WRITE_TASK_KIND,
} from './world-write.constants';
import {
  CandidateMentions,
  DroppedWorldQuote,
  DroppedWorldSource,
  PendingWorldStep,
  stepAt,
  stepKey,
  stepsTotalOf,
  WORLD_BLOCKS,
  WorldBlock,
  WorldCandidate,
  WorldFix,
  WorldItem,
  WorldSource,
  WorldStep,
  WorldStepKind,
  WorldStepSource,
  WorldWriteData,
  withItem,
  withoutRegen,
  worldDataJson,
  readWorldData,
} from './world-write.data';
import {
  lockWorldRuns,
  WorldGate,
  worldRegenGate,
  worldRunGate,
  WorldWriteFields,
} from './world-write.fields';
import { WORLD_STEP_STAGES, WorldRegenSpec } from './world-write.prompts';
import {
  externalInput,
  largestFitting,
  mainCharacters,
  pageBook,
  pageInput,
  selectInput,
  WorldBaseCharacter,
  WorldContext,
  worldCharacters,
  worldInputFits,
  worldLoopSpec,
  WorldStepInput,
} from './world-write.steps';

/** Задача хода мира: одна задача - один шаг; `index` - перегенерация пункта `index` своей операцией. */
export const worldWriteTaskInput = (
  row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
  operationId: string,
  index: number | null = null,
): EnqueueTaskInput => runTaskInput(WORLD_WRITE_TASK_KIND, row, operationId, index);

/** Героя не нашли формы имени ни в одной главе: страницу не на чем строить. */
export const WORLD_CHARACTER_NOT_FOUND = 'WORLD_CHARACTER_NOT_FOUND';
/** Внешний шаг героя, чья страница не удалась, не идёт (виден как `failedReason` шага). */
export const WORLD_PAGE_MISSING = 'WORLD_PAGE_MISSING';

/** Ни один источник не открылся по вине канала: пауза `STEP_FAILED`, «Continue» повторяет шаг. */
class SourcesOffline extends Error {
  constructor() {
    super('No source of the external step could be reached: the network of the worker is down');
    this.name = 'SourcesOffline';
  }
}

/** Блоки страницы во входе внешнего шага: о герое своими словами, без цитат, сцен и глав. */
const EXTERNAL_INPUT_BLOCKS: ReadonlySet<WorldBlock> = new Set(['short', 'profile', 'character']);

/** Версий книги в выборке названий для проверки страниц источников. */
const NAME_VERSIONS_MAX = 10;
/** Пауза перед повтором источников после 403/429, одна на шаг (как у хода анализа). */
const REFUSAL_RETRY_PAUSE_MS = 2000;
const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isSiteRefusal = (page: SourceFetchResult): boolean =>
  !page.ok && page.reason === 'HTTP_STATUS' && (page.status === 403 || page.status === 429);

const retryable = (page: SourceFetchResult): boolean =>
  !page.ok &&
  (page.reason === 'NETWORK' ||
    page.reason === 'TIMEOUT' ||
    page.reason === 'CONNECTION' ||
    (page.reason === 'HTTP_STATUS' && (page.status ?? 0) >= 500) ||
    isSiteRefusal(page));

/**
 * Открытие источников внешнего шага - правилом хода анализа: разовый сбой канала, сервера и отказ
 * 403/429 - один повтор, перед повтором после 403/429 - одна пауза; `transport` - отказ канала.
 */
async function openWorldSources(
  fetcher: Pick<SourceFetcherService, 'fetchMany'>,
  sources: readonly WorldSource[],
  pause: (ms: number) => Promise<void> = waitMs,
): Promise<PageCheck[]> {
  const urls = sources.map((s) => s.url);
  if (urls.length === 0) return [];
  const pages: SourceFetchResult[] = await fetcher.fetchMany(urls, new Map());
  const again = pages.flatMap((page, i) => (retryable(page) ? [i] : []));
  if (again.length > 0) {
    if (again.some((i) => isSiteRefusal(pages[i]))) await pause(REFUSAL_RETRY_PAUSE_MS);
    const second = await fetcher.fetchMany(
      again.map((i) => urls[i]),
      new Map(),
    );
    again.forEach((i, k) => (pages[i] = second[k]));
  }
  return pages.map((page, i) => ({
    host: page.host || hostOf(urls[i]),
    opened: page.ok,
    text: page.ok ? page.text : '',
    transport: page.reason === 'NETWORK',
  }));
}

/** Присутствие кандидатов по текстам глав (в памяти, без записи - пишет только пересчёт, R2). */
function countCandidates(
  chapters: ReadonlyArray<{ number: number; content: string }>,
  candidates: ReadonlyArray<{
    key: string;
    name: string;
    aliases: string[];
    exclusions: string[];
    chapterExclusions: WorldChapterExclusion[] | null;
  }>,
): Map<string, CandidateMentions> {
  const counter = new WorldMentionCounter(
    candidates.map((c) => ({
      key: c.key,
      name: c.name,
      aliases: c.aliases,
      aliasExclusions: c.exclusions,
      aliasChapterExclusions: c.chapterExclusions,
    })),
    new Set<string>(),
  );
  for (const chapter of chapters)
    counter.addChapterText(chapter.number, htmlToParagraphs(chapter.content));
  const result = counter.result();
  return new Map(
    candidates.map((c) => {
      const m = result.get(c.key);
      return [c.key, { chapters: m?.chapters ?? [], perChapter: m?.perChapter ?? {} }] as const;
    }),
  );
}

/**
 * Снятые источники, на которые ссылается внешний блок `block` ответа: по номерам источников в ответе
 * (`droppedAt` проверки), а не по названию и хосту - хост снятого источника берётся у фетчера после
 * переходов и с адресом из ответа не совпадает.
 */
export function droppedOfBlock(
  verdict: Pick<WorldExternalVerdict, 'droppedSources' | 'droppedAt'>,
  draft: Pick<WorldExternalDraft, 'refs'>,
  block: WorldBlock,
): DroppedWorldSource[] {
  const refs =
    block === 'adaptations'
      ? draft.refs.adaptations.flat()
      : block === 'critique' || block === 'prototypes'
        ? draft.refs[block]
        : [];
  const own = new Set(refs);
  return verdict.droppedSources.filter((_, k) => own.has(verdict.droppedAt[k]));
}

/**
 * Снятые источники перегенерации - в список хода без повторов (по названию, хосту и причине, как
 * `withRegenDropped` хода анализа): повторная перегенерация с тем же источником его не дублирует.
 */
export function withDroppedSources(
  current: readonly DroppedWorldSource[],
  added: readonly DroppedWorldSource[],
): DroppedWorldSource[] {
  const key = (d: DroppedWorldSource) => `${d.key}\u0000${d.title}\u0000${d.host}\u0000${d.reason}`;
  const known = new Set(current.map(key));
  return [...current, ...added.filter((d) => !known.has(key(d)))];
}

/** Итог шага до записи. */
interface StepRecord {
  step: WorldStep;
  items: WorldItem[];
  candidates?: WorldCandidate[];
  droppedQuotes: DroppedWorldQuote[];
  droppedSources: DroppedWorldSource[];
}

const verdictOf = (remarks: readonly DraftRemark[], answered: boolean) =>
  remarks.length === 0 && answered ? ('ok' as const) : ('flags' as const);

/** Блоки хода - для отнесения замечания к блоку по его пути. */
const BLOCK_NAMES: ReadonlySet<string> = new Set(WORLD_BLOCKS);

/** Замечания пункта: с путём своего блока; без пути блока - у всех блоков шага. */
function remarksOfBlock(remarks: readonly DraftRemark[], block: WorldBlock): DraftRemark[] {
  return remarks.filter((r) => {
    const head = blockOfPath(r.where);
    return BLOCK_NAMES.has(head) ? head === block : true;
  });
}

function emptyItem(key: string, block: WorldBlock, step: number): WorldItem {
  return {
    key,
    block,
    step,
    verdict: 'ok',
    remarks: [],
    review: null,
    outcome: 'waiting',
    value: null,
    sources: null,
    name: null,
    base: null,
    failedReason: null,
    regen: null,
    regenFailedReason: null,
  };
}

function failedStep(
  step: number,
  kind: WorldStepKind,
  key: string | null,
  reason: string,
  source: WorldStepSource | null,
): WorldStep {
  return {
    step,
    kind,
    key,
    verdict: 'failed',
    remarks: [],
    attempt: 1,
    outcome: 'failed',
    failedReason: reason,
    authorModel: null,
    review: null,
    source,
    dropped: [],
  };
}

function doneStep<T>(
  step: number,
  kind: WorldStepKind,
  key: string | null,
  result: Extract<QualityLoopResult<T>, { ok: true }>,
  remarks: DraftRemark[],
  source: WorldStepSource,
  dropped: WorldFix[],
): WorldStep {
  return {
    step,
    kind,
    key,
    verdict:
      remarks.length === 0 && result.review.kind === 'answered' && dropped.length === 0
        ? 'ok'
        : 'flags',
    remarks,
    attempt: result.attempt,
    outcome: 'done',
    failedReason: null,
    authorModel: result.authorModel,
    review: result.review,
    source,
    dropped,
  };
}

/** Итог шага в данных хода: запись шага, пункты, кандидаты, выброшенные цитаты и источники. */
function withStep(data: WorldWriteData, record: StepRecord): WorldWriteData {
  return {
    ...data,
    candidates: record.candidates ?? data.candidates,
    steps: [...data.steps, record.step],
    items: [...data.items, ...record.items],
    droppedQuotes: [...data.droppedQuotes, ...record.droppedQuotes],
    droppedSources: [...data.droppedSources, ...record.droppedSources],
    pending: null,
  };
}

/**
 * Шаги хода «Write World» (`F08-4a`; `features/F08-book-wiki/tech.md` §5): выбор героев и форм имени,
 * затем на каждого героя - страница и внешние блоки; каждый шаг - циклом качества `F06-1` с
 * проверяющей `world_review`, запись после каждого шага (обрыв не теряет готового), оплаченный текст
 * шага хранится до проверяющей и до переделки. После последнего шага ход `ready`.
 */
@Injectable()
export class WorldWriteHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly tasks: LlmTaskService,
    private readonly dossiers: DossierDemandService,
    private readonly drafts: ContentDraftService,
    private readonly fields: WorldWriteFields,
    private readonly fetcher: SourceFetcherService,
  ) {}

  readonly handler: LlmTaskHandler = {
    run: (task, ctx) => this.run(task, ctx),
    onFailed: (task, reason) => pauseOnFailure(this.tasks, task, reason),
  };

  /** «Continue» операции перегенерации: строка по отметке `regen.operationId`. */
  regenResume(op: LlmOperation): Promise<EnqueueTaskInput[]> {
    return regenResumeOf(
      this.prisma,
      'world_write',
      op,
      (data) => readWorldData(data).items,
      worldWriteTaskInput,
    );
  }

  /** Отмена операции перегенерации: отметка снимается у её пункта, ход остаётся `ready`. */
  onRegenCancelled(op: LlmOperation, tx: Prisma.TransactionClient): Promise<void> {
    return this.clearRegenMark(op.id, tx);
  }

  clearRegenMark(
    operationId: string,
    tx: Prisma.TransactionClient,
    failedReason: string | null = null,
  ): Promise<void> {
    return clearRegenMarkOf(tx, 'world_write', operationId, {
      // Тот же замок строки хода, что у `mutate`, «Accept» и «Discard» (L-019).
      lock: lockWorldRuns,
      read: readWorldData,
      clear: (data, index) => worldDataJson(withoutRegen(data, index, failedReason)),
    });
  }

  private async run(task: LlmTask, ctx: LlmTaskContext): Promise<LlmTaskStepResult> {
    const { index } = runTaskPayload(task);
    const row = await draftRowOf(this.prisma, task);
    if (index !== null) {
      if (!row || row.kind !== 'world_write') return this.finishRegen(task.operationId);
      return this.regenStep(row, index, task, ctx);
    }
    if (
      !row ||
      row.kind !== 'world_write' ||
      row.status !== 'building' ||
      row.operationId !== task.operationId
    ) {
      return stepGone(this.tasks, task.operationId);
    }
    if (!row.dossierId) {
      return awaitDraftContext(
        {
          db: this.prisma,
          tasks: this.tasks,
          dossiers: this.dossiers,
          languageOf: (versionId) => this.drafts.languageOf(versionId),
        },
        row,
      );
    }
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } });
    if (!dossier) return failRun(this.tasks, row, DRAFT_INPUT_MISSING);
    try {
      return await this.runStep(row, worldRunGate(row.operationId), dossier.data, ctx);
    } catch (error) {
      if (error instanceof NotFoundException) return failRun(this.tasks, row, DRAFT_INPUT_MISSING);
      throw error;
    }
  }

  private async runStep(
    row: ContentDraft,
    gate: WorldGate,
    dossier: unknown,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    let data = await this.fields.read(row, gate);
    if (!data) return stepGone(this.tasks, row.operationId);
    if (data.stepsBroken) return failRun(this.tasks, row, DRAFT_DATA_INVALID);
    // Итог шага сохранён, а запись не дошла (обрыв между записями): дописать.
    const waiting = [
      ...new Set(data.items.filter((i) => i.outcome === 'waiting').map((i) => i.step)),
    ];
    for (const step of waiting) {
      if ((await this.fields.settleStep(row, gate, step)) === 'gone') {
        return stepGone(this.tasks, row.operationId);
      }
    }
    data = await this.fields.read(row, gate);
    if (!data) return stepGone(this.tasks, row.operationId);
    const step = data.steps.length;
    const total = stepsTotalOf(data);
    if (total !== null && step >= total) return finishRun(this.tasks, row);
    const context = await this.contextOf(row, dossier);
    if (step === 0 && mainCharacters(context.analysis).length === 0) {
      return failRun(this.tasks, row, WORLD_ANALYSIS_MISSING);
    }
    const record = await this.produceStep(row, gate, step, context, data, data.pending, ctx);
    if (record === null) return stepGone(this.tasks, row.operationId);
    await ctx.renewLease();
    // Шаг уже записан другой попыткой (аренда истекла посреди вызова): этот итог не пишется, ход
    // продолжается с записанного - как у хода анализа; `null` от `mutate` - только «ход ушёл».
    // Колбэк зовётся, только если ход прошёл `gate`: не вызван - ход ушёл; вызван без записи - шаг
    // уже записан другой попыткой, строка хода не переписывается.
    let reached = false;
    const saved = await this.fields.mutate(row, gate, (current) => {
      reached = true;
      return current.steps.length === step ? withStep(current, record) : null;
    });
    if (!reached) return stepGone(this.tasks, row.operationId);
    if (!saved) return { kind: 'continue' };
    if ((await this.fields.settleStep(row, gate, step)) === 'gone') {
      return stepGone(this.tasks, row.operationId);
    }
    return { kind: 'continue' };
  }

  /** Шаг `step`: цикл качества и итог; `null` - ход больше не принимает шаг этой операции. */
  private async produceStep(
    row: ContentDraft,
    gate: WorldGate,
    step: number,
    context: WorldContext,
    data: WorldWriteData,
    pending: PendingWorldStep | null,
    ctx: LlmTaskContext,
    regen: { spec: WorldRegenSpec; index: number } | null = null,
  ): Promise<StepRecord | null> {
    const { kind, candidate: at } = stepAt(step);
    // Индекс глав - только выбору и странице: внешний шаг текста книги не читает.
    const quotes = () =>
      indexChapters(new Map(context.chapters.map((c) => [c.number, htmlToParagraphs(c.content)])));
    const fits = <T>(input: WorldStepInput<T>) => worldInputFits(this.llm, input);
    const empty = { droppedQuotes: [], droppedSources: [] };

    if (kind === 'select') {
      const base = worldCharacters(context.analysis);
      const index = quotes();
      const make = (count: number) =>
        selectInput(context, base, index, {
          text: chaptersText(context.chapters.slice(0, count)) || 'none',
          partial: count < context.chapters.length,
        });
      // Весь текст сначала; не влез - наибольший префикс глав, как у страницы.
      const whole = make(context.chapters.length);
      const input = (await fits(whole))
        ? whole
        : await largestFitting(context.chapters.length, make, fits);
      const result = input ? await this.loop(row, gate, input, step, pending, ctx, null) : null;
      if (result === null && input !== null) return null;
      const answer = result?.ok ? result.draft : null;
      const candidates = await this.candidatesOf(row.bookVersionId, context, base, answer, index);
      const stepRecord =
        input === null
          ? failedStep(step, kind, null, DRAFT_TOO_LONG, null)
          : !result?.ok
            ? failedStep(step, kind, null, DRAFT_INVALID_RESPONSE, input.source)
            : doneStep(step, kind, null, result, result.remarks, input.source, answer?.fixes ?? []);
      return { step: stepRecord, items: [], candidates, ...empty };
    }

    const candidate = data.candidates?.[at ?? -1];
    if (!candidate)
      return { step: failedStep(step, kind, null, DRAFT_DATA_INVALID, null), items: [], ...empty };

    if (kind === 'page') {
      if (candidate.mentions.chapters.length === 0) {
        return {
          step: failedStep(step, kind, candidate.key, WORLD_CHARACTER_NOT_FOUND, null),
          items: [],
          ...empty,
        };
      }
      const index = quotes();
      const make = (top: number | null) =>
        pageInput(
          context,
          candidate,
          index,
          pageBook(context, candidate, top),
          regen?.spec ?? null,
        );
      const whole = make(null);
      const input = (await fits(whole))
        ? whole
        : await largestFitting(candidate.mentions.chapters.length, (n) => make(n), fits);
      if (input === null) {
        return {
          step: failedStep(step, kind, candidate.key, DRAFT_TOO_LONG, null),
          items: [],
          ...empty,
        };
      }
      const result = await this.loop(row, gate, input, step, pending, ctx, regen);
      if (result === null) return null;
      if (!result.ok) {
        return {
          step: failedStep(step, kind, candidate.key, DRAFT_INVALID_RESPONSE, input.source),
          items: [],
          ...empty,
        };
      }
      return pageRecord(step, candidate, result, input.source, regen !== null);
    }

    // Страница героя не удалась (героя нет в тексте, не влез вход, нет ответа) или ничего не
    // записала - сущности нет: внешний шаг не платит за вызовы, его запись всё равно отказала бы.
    const pageStep = data.steps.find((s) => s.step === step - 1);
    if (!regen && (pageStep?.outcome !== 'done' || !context.entities.has(candidate.key))) {
      return {
        step: failedStep(step, kind, candidate.key, WORLD_PAGE_MISSING, null),
        items: [],
        ...empty,
      };
    }
    // Внешние блоки: итог страницы этого героя - вход, текста книги шаг не читает - ни глав, ни
    // цитат страницы (`tech.md` §5: название, автор, язык, имя и итог страницы без опор по тексту).
    const page = Object.fromEntries(
      data.items
        .filter(
          (i) =>
            i.key === candidate.key &&
            i.step === step - 1 &&
            i.value !== null &&
            EXTERNAL_INPUT_BLOCKS.has(i.block),
        )
        .map((i) => [i.block, i.value]),
    );
    const input = externalInput(context, candidate, page, regen?.spec ?? null);
    if (!(await fits(input))) {
      return {
        step: failedStep(step, kind, candidate.key, DRAFT_TOO_LONG, 'none'),
        items: [],
        ...empty,
      };
    }
    const result = await this.loop(row, gate, input, step, pending, ctx, regen);
    if (result === null) return null;
    if (!result.ok) {
      return {
        step: failedStep(step, kind, candidate.key, DRAFT_INVALID_RESPONSE, 'none'),
        items: [],
        ...empty,
      };
    }
    const invalid = invalidBlocks(result.remarks);
    const valid: WorldExternalDraft = {
      ...result.draft,
      blocks: Object.fromEntries(
        Object.entries(result.draft.blocks).filter(([block]) => !invalid.has(block)),
      ),
    };
    const checks = await openWorldSources(this.fetcher, valid.sources);
    if (sourcesOffline(checks)) throw new SourcesOffline();
    const verdict = verifyWorldExternal(
      candidate.key,
      valid,
      checks,
      context.names.titles,
      context.names.authors,
    );
    const remarks = [...result.remarks, ...externalChecks(verdict.blocks)];
    const fixes = [...result.draft.fixes, ...verdict.fixes];
    const answered = result.review.kind === 'answered';
    const items: WorldItem[] = [];
    for (const block of ['critique', 'prototypes', 'adaptations'] as const) {
      const value = verdict.blocks[block];
      const own = remarksOfBlock(remarks, block);
      if (value !== undefined) {
        items.push({
          ...emptyItem(candidate.key, block, step),
          verdict: verdictOf(own, answered),
          remarks: own,
          review: result.review,
          value,
          sources: verdict.sourcesOf[block] ?? [],
        });
      } else if (verdict.unverified.includes(block) || invalid.has(block)) {
        items.push({
          ...emptyItem(candidate.key, block, step),
          verdict: 'failed',
          remarks: own,
          review: result.review,
          outcome: 'none',
          failedReason: invalid.has(block) ? 'IMPORT_INVALID' : EXTERNAL_UNVERIFIED,
        });
      }
    }
    return {
      step: doneStep(step, kind, candidate.key, result, remarks, 'none', fixes),
      items,
      droppedQuotes: [],
      // Перегенерация одного блока: снятые источники - только те, на которые ссылается он сам.
      droppedSources: regen
        ? droppedOfBlock(verdict, valid, regen.spec.block)
        : verdict.droppedSources,
    };
  }

  /** Цикл качества шага с хранением оплаченного текста; `null` - ход ушёл. */
  private async loop<T>(
    row: ContentDraft,
    gate: WorldGate,
    input: WorldStepInput<T>,
    step: number,
    pending: PendingWorldStep | null,
    ctx: LlmTaskContext,
    regen: { index: number } | null,
  ): Promise<QualityLoopResult<T> | null> {
    const owner = gate.kind === 'ready' ? row.operationId : gate.operationId;
    const op = await this.prisma.llmOperation.findUnique({
      where: { id: owner },
      select: { settingsSnapshot: true },
    });
    const snapshot = op?.settingsSnapshot ?? null;
    const key = regen ? `regen:${regen.index}` : stepKey(step);
    const keep = async (resume: PendingWorldStep['resume']) => {
      const saved = await this.fields.mutate(row, gate, (data) => {
        const next = { key, operationId: owner, resume };
        if (!regen) return { ...data, pending: next };
        const current = data.items[regen.index]?.regen;
        return current
          ? withItem(data, regen.index, { regen: { ...current, pending: next } })
          : null;
      });
      if (saved === null) throw new RunGone();
    };
    try {
      return await runQualityLoop(this.llm, owner, ctx, {
        ...worldLoopSpec(input, {
          author: runStageModels(snapshot, null, WORLD_STEP_STAGES[input.kind]),
          review: runStageModels(snapshot, null, WORLD_REVIEW_STAGE),
        }),
        onAuthored: (a) => keep({ draft: a.draft, attempt: a.attempt, authorModel: a.authorModel }),
        onBeforeRedo: (first) =>
          keep({
            draft: first.draft,
            attempt: 1,
            authorModel: first.authorModel,
            checked: { remarks: first.remarks, review: first.review },
          }),
        resume:
          pending && pending.key === key && pending.operationId === owner
            ? (pending.resume as QualityLoopResume<T>)
            : undefined,
      });
    } catch (error) {
      if (error instanceof RunGone) return null;
      throw error;
    }
  }

  /**
   * Кандидаты после выбора: имя и формы из ответа (нет ответа - имя анализа), формы и исключения
   * сохранённой сущности, присутствие по текстам глав - до страницы, в памяти.
   */
  private async candidatesOf(
    bookVersionId: string,
    context: WorldContext,
    base: ReadonlyArray<WorldBaseCharacter>,
    answer: WorldSelectDraft | null,
    index: ChapterIndex,
  ): Promise<WorldCandidate[]> {
    const folded = foldedVersion(index);
    const exclusions = await this.prisma.bookWorldEntity.findMany({
      where: { bookVersionId, key: { in: base.map((c) => c.key) } },
      select: { key: true, aliasExclusions: true, aliasChapterExclusions: true },
      take: BOOK_WORLD_LIMITS.entities,
    });
    // Исключённые главы у формы (`F08-8a`): кандидат считается тем же правилом, что пересчёт.
    const chapterExcluded = new Map(
      exclusions.map((e) => [e.key, readAliasChapterExclusions(e.aliasChapterExclusions)]),
    );
    const excluded = new Map(
      exclusions.map((e) => [
        e.key,
        Array.isArray(e.aliasExclusions)
          ? e.aliasExclusions.filter((x): x is string => typeof x === 'string')
          : [],
      ]),
    );
    const named = base.map((c) => {
      const found = answer?.characters.find((a) => a.key === c.key);
      const stored = context.entities.get(c.key);
      // Формы - ответа модели (или сохранённые), плюс досье (имя, варианты, обращения к герою) и
      // глоссарий запуска (`tech.md` §4); каждая - только если стоит в тексте версии.
      const forms = dossierForms(
        { key: c.key, name: c.name },
        context.dossier,
        context.glossary,
        folded,
      );
      return {
        key: c.key,
        role: c.role,
        name: found?.name ?? stored?.name ?? c.name,
        // Сохранённые формы (их мог дописать редактор) - первыми: ответ модели их не вытесняет.
        aliases: [
          ...new Set([...(stored?.aliases ?? []), ...(found?.aliases ?? []), ...forms]),
        ].slice(0, BOOK_WORLD_LIMITS.aliases),
        exclusions: excluded.get(c.key) ?? [],
        chapterExclusions: chapterExcluded.get(c.key) ?? null,
      };
    });
    const mentions = countCandidates(context.chapters, named);
    return (
      named
        .map((c) => ({
          key: c.key,
          role: c.role,
          name: c.name,
          aliases: c.aliases,
          mentions: mentions.get(c.key) ?? { chapters: [], perChapter: {} },
        }))
        // Второстепенный ниже порога глав на сайт не выйдет (`F08-8b`): страницу ему не пишут.
        .filter((c) => worldRolePasses(c.role, c.mentions.chapters.length))
    );
  }

  /**
   * Перегенерация пункта `index` хода `ready`: шаг пункта тем же циклом качества, замечание редактора
   * и прежнее содержимое в промпт автора, остальные блоки ответа отброшены; итог решается как итог
   * шага - в блок или предложением.
   */
  private async regenStep(
    row: ContentDraft,
    index: number,
    task: LlmTask,
    ctx: LlmTaskContext,
  ): Promise<LlmTaskStepResult> {
    const gate = worldRegenGate(task.operationId, index);
    const data = await this.fields.read(row, gate);
    const item = data?.items[index];
    if (!data || !item?.regen) return this.finishRegen(task.operationId);
    if (item.outcome === 'waiting') {
      const settled = await this.fields.settleStep(row, gate, item.step, index);
      return this.finishRegen(task.operationId, settled === 'refused' ? WORLD_WRITE_REFUSED : null);
    }
    if (item.regen.previous !== null) return this.finishRegen(task.operationId);
    const dossier = row.dossierId
      ? await this.prisma.bookDossier.findUnique({ where: { id: row.dossierId } })
      : null;
    if (!dossier) return this.finishRegen(task.operationId, DRAFT_INPUT_MISSING);
    try {
      const context = await this.contextOf(row, dossier.data);
      const stored = context.entities.get(item.key);
      const spec: WorldRegenSpec = {
        block: item.block,
        current: (stored ? stored[item.block] : null) ?? item.value,
        remark: item.regen.remark,
      };
      const record = await this.produceStep(
        row,
        gate,
        item.step,
        context,
        data,
        item.regen.pending,
        ctx,
        {
          spec,
          index,
        },
      );
      if (record === null) return await this.finishRegen(task.operationId);
      const fresh = record.items.find((i) => i.block === item.block);
      if (record.step.outcome === 'failed' || !fresh || fresh.outcome === 'none') {
        return await this.finishRegen(
          task.operationId,
          fresh?.failedReason ?? record.step.failedReason ?? DRAFT_INVALID_RESPONSE,
        );
      }
      await ctx.renewLease();
      const saved = await this.fields.mutate(row, gate, (current) => {
        const at = current.items[index];
        if (!at?.regen) return null;
        return {
          ...withItem(current, index, {
            verdict: fresh.verdict,
            remarks: fresh.remarks,
            review: fresh.review,
            outcome: 'waiting',
            value: fresh.value,
            sources: fresh.sources,
            base: null,
            failedReason: null,
            regenFailedReason: null,
            regen: { ...at.regen, pending: null, previous: { ...at, regen: null } },
          }),
          // Выброшенное - только своего блока: прочие блоки ответа перегенерации отброшены.
          droppedQuotes:
            item.block === 'quotes'
              ? [...current.droppedQuotes, ...record.droppedQuotes]
              : current.droppedQuotes,
          droppedSources: withDroppedSources(current.droppedSources, record.droppedSources),
        };
      });
      if (!saved) return await this.finishRegen(task.operationId);
      const settled = await this.fields.settleStep(row, gate, item.step, index);
      return await this.finishRegen(
        task.operationId,
        settled === 'refused' ? WORLD_WRITE_REFUSED : null,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        return this.finishRegen(task.operationId, DRAFT_INPUT_MISSING);
      }
      throw error;
    }
  }

  private async finishRegen(
    operationId: string,
    failedReason: string | null = null,
  ): Promise<LlmTaskStepResult> {
    await this.tasks.completeOperation(operationId, (tx) =>
      this.clearRegenMark(operationId, tx, failedReason),
    );
    return { kind: 'done' };
  }

  /** Версия, глоссарий, главы, анализ версии, сущности мира и названия всех версий книги. */
  async contextOf(row: ContentDraft, dossier: unknown): Promise<WorldContext> {
    const [version, glossary, chapters, analysis, entities, versions] = await Promise.all([
      this.prisma.bookVersion.findUnique({
        where: { id: row.bookVersionId },
        select: { title: true, author: true, originalLanguage: true },
      }),
      row.glossaryId
        ? this.prisma.bookGlossary.findUnique({
            where: { id: row.glossaryId },
            select: { data: true },
          })
        : null,
      allChapters(this.prisma, row.bookVersionId, { number: true, title: true, content: true }),
      this.prisma.bookAnalysis.findUnique({
        where: { bookVersionId: row.bookVersionId },
        select: BOOK_ANALYSIS_SELECT,
      }),
      this.prisma.bookWorldEntity.findMany({
        where: { bookVersionId: row.bookVersionId },
        select: BOOK_WORLD_PUBLIC_SELECT,
        orderBy: { key: 'asc' },
        take: BOOK_WORLD_LIMITS.entities,
      }),
      this.prisma.bookVersion.findMany({
        where: { book: { versions: { some: { id: row.bookVersionId } } } },
        select: { title: true, author: true },
        take: NAME_VERSIONS_MAX,
      }),
    ]);
    if (!version) throw new NotFoundException('Book version not found');
    return {
      language: row.language,
      dossier,
      glossary: glossary?.data ?? null,
      bookTitle: version.title,
      author: version.author,
      originalLanguage: version.originalLanguage ?? '',
      chapters: withChapterText(chapters),
      analysis: analysis ? readStoredAnalysis(analysis) : EMPTY_BOOK_ANALYSIS,
      entities: new Map(entities.map((e) => [e.key, readStoredEntity(e)])),
      names: {
        titles: [...new Set([version.title, ...versions.map((v) => v.title)])].filter(
          (t) => t !== '',
        ),
        authors: [...new Set([version.author, ...versions.map((v) => v.author)])].filter(
          (a) => a !== '',
        ),
      },
    };
  }
}

/** Итог страницы: пункт на блок (формы имени - из выбора), неверные по импорту - не пишутся. */
function pageRecord(
  step: number,
  candidate: WorldCandidate,
  result: Extract<QualityLoopResult<WorldPageDraft>, { ok: true }>,
  source: WorldStepSource,
  regen: boolean,
): StepRecord {
  const invalid = invalidBlocks(result.remarks);
  const answered = result.review.kind === 'answered';
  const name = result.draft.name ?? candidate.name;
  const items: WorldItem[] = [];
  if (!regen && candidate.aliases.length > 0) {
    items.push({ ...emptyItem(candidate.key, 'aliases', step), value: candidate.aliases, name });
  }
  for (const [block, value] of Object.entries(result.draft.blocks) as Array<
    [WorldBlock, unknown]
  >) {
    const own = remarksOfBlock(result.remarks, block);
    if (invalid.has(block)) {
      items.push({
        ...emptyItem(candidate.key, block, step),
        verdict: 'failed',
        remarks: own,
        review: result.review,
        outcome: 'none',
        failedReason: 'IMPORT_INVALID',
      });
      continue;
    }
    items.push({
      ...emptyItem(candidate.key, block, step),
      verdict: verdictOf(own, answered),
      remarks: own,
      review: result.review,
      value,
      name,
    });
  }
  return {
    step: doneStep(step, 'page', candidate.key, result, result.remarks, source, result.draft.fixes),
    items,
    droppedQuotes: result.draft.droppedQuotes,
    droppedSources: [],
  };
}
