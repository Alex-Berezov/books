import { Injectable, NotFoundException } from '@nestjs/common';
import { ContentDraft, Language, LlmOperation, LlmTask, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BOOK_ANALYSIS_SELECT,
  EMPTY_BOOK_ANALYSIS,
  readStoredAnalysis,
} from '../../book-analysis/book-analysis-data';
import {
  BOOK_WORLD_PUBLIC_SELECT,
  briefBasisBlock,
  readAliasChapterExclusions,
  type StoredWorldEntity,
  readStoredEntity,
} from '../../book-world/book-world-data';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { WorldMentionCounter, type WorldChapterExclusion } from '../../book-world/world-mentions';
import { WorldMentionsService } from '../../book-world/world-mentions.service';
import { worldRolePasses } from '../../book-world/world-public';
import {
  missingPairMembers,
  pairEvidenceOf,
  pairFounded,
  pairKeyTaken,
  savedMentionsOf,
} from '../../book-world/world-refs';
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
import { ChapterIndex } from '../draft-quality/quote-check';
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
  dossierEntityForms,
  dossierForms,
  externalChecks,
  foldedVersion,
  invalidBlocks,
  verifyWorldExternal,
  WorldExternalDraft,
  WorldExternalVerdict,
  selectForms,
  WorldObjectDraft,
  WorldPageDraft,
  WorldPairDraft,
  WorldPlaceDraft,
  WorldSelectDraft,
} from './world-write.checks';
import {
  WORLD_ANALYSIS_MISSING,
  WORLD_MENTIONS_MOVED,
  WORLD_EVENT_KEY_TAKEN,
  WORLD_EVENT_NOT_FOUND,
  WORLD_OBJECT_KEY_TAKEN,
  WORLD_OBJECT_NOT_FOUND,
  WORLD_PAIR_KEY_TAKEN,
  WORLD_PAIR_MEMBER_MISSING,
  WORLD_PAIR_NOT_FOUNDED,
  WORLD_PLACE_KEY_TAKEN,
  WORLD_PLACE_NOT_FOUND,
  WORLD_REVIEW_STAGE,
  WORLD_STEP_OUT_OF_RUN,
  WORLD_TERM_KEY_TAKEN,
  WORLD_TERM_NOT_FOUND,
  WORLD_WRITE_REFUSED,
  WORLD_WRITE_TASK_KIND,
} from './world-write.constants';
import {
  CandidateMentions,
  DroppedWorldQuote,
  DroppedWorldSource,
  PendingWorldStep,
  stepKey,
  stepOfData,
  stepsTotalOf,
  WORLD_BLOCKS,
  WorldBlock,
  WorldCandidate,
  WorldDossierCandidate,
  WorldDossierType,
  WorldFix,
  WorldRunObjectType,
  WORLD_DOSSIER_LISTS,
  WorldEventCandidate,
  WorldEventsOffReason,
  WorldListType,
  isRunObjectType,
  runListOf,
  WorldItem,
  WorldObjectCandidate,
  WorldObjectsOffReason,
  WorldPairCandidate,
  WorldPairsOffReason,
  WorldPlaceCandidate,
  WorldPlaceKindValue,
  WorldPlacesOffReason,
  WorldSkip,
  WorldSource,
  WorldStep,
  WorldStepKind,
  WorldStepSource,
  WorldTermsOffReason,
  WorldWriteData,
  blockIsEmpty,
  entityBlock,
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
  chapterIndexOf,
  externalInput,
  fittingInput,
  objectInput,
  pageBook,
  runCharacters,
  runMainCharacters,
  pageInput,
  pairBook,
  pairChapters,
  pairFallbackName,
  pairInput,
  placeInput,
  selectInput,
  storedCharacterKeys,
  WorldBaseCharacter,
  WorldContext,
  worldInputFits,
  worldLoopSpec,
  WorldPairMembers,
  WorldStepInput,
} from './world-write.steps';
import { ChosenCandidates, choosePairs } from './world-write.pairs';
import { placesToChoose } from './world-write.places';
import { objectsToChoose, organizationsSkipped } from './world-write.objects';
import {
  chaptersExcludedForAllForms,
  EVENTS_OFF,
  eventMentions,
  eventsMode,
  knownWorldEvents,
  originalLanguageCode,
  pickEvents,
  selectEvents,
} from './world-write.events';
import {
  chooseDossierEntities,
  dossierEntityKeys,
  dossierKeyTaken,
  entriesAfterPairs,
  type WorldDossierChosen,
} from './world-write.dossier-entities';

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

/** Ход ушёл во время проверок шага пары: шаг не пишется (`null` из `produceStep`). */
const RUN_GONE = 'RUN_GONE';

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

/** Присутствие кандидата в памяти и общие главы с другими кандидатами (`F08-8e`, отбор пар). */
interface CountedCandidate extends CandidateMentions {
  coPresence: Record<string, number[]>;
}

/**
 * Присутствие кандидатов по текстам глав (в памяти, без записи - пишет только пересчёт, R2) и общие
 * главы между ними - вход отбора пар (решение арбитра `F08 | F08-8e-1` Q1).
 */
function countCandidates(
  chapters: ReadonlyArray<{ number: number; content: string }>,
  candidates: ReadonlyArray<{
    key: string;
    name: string;
    aliases: string[];
    exclusions: string[];
    chapterExclusions: WorldChapterExclusion[] | null;
  }>,
): Map<string, CountedCandidate> {
  const counter = new WorldMentionCounter(
    candidates.map((c) => ({
      key: c.key,
      name: c.name,
      aliases: c.aliases,
      aliasExclusions: c.exclusions,
      aliasChapterExclusions: c.chapterExclusions,
    })),
    new Set(candidates.map((c) => c.key)),
  );
  for (const chapter of chapters)
    counter.addChapterText(chapter.number, htmlToParagraphs(chapter.content));
  const result = counter.result();
  return new Map(
    candidates.map((c) => {
      const m = result.get(c.key);
      return [
        c.key,
        {
          chapters: m?.chapters ?? [],
          perChapter: m?.perChapter ?? {},
          coPresence: m?.coPresence ?? {},
        },
      ] as const;
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
  /** Итог выбора (`F08-8e`): пары, отсеянные и причина хода без пар. */
  pairs?: WorldPairCandidate[];
  leftOut?: WorldSkip[];
  pairsOff?: WorldPairsOffReason | null;
  /** Итог выбора мест (`F08-12b`): места хода и причина хода без мест. */
  places?: WorldPlaceCandidate[];
  placesOff?: WorldPlacesOffReason | null;
  /** Итог выбора предметов и понятий (`F08-13b`): списки хода и причины хода без них. */
  objects?: WorldObjectCandidate[];
  terms?: WorldObjectCandidate[];
  objectsOff?: WorldObjectsOffReason | null;
  termsOff?: WorldTermsOffReason | null;
  /** Итог выбора событий (`F08-13b-2`): события хода и причина хода без событий. */
  events?: WorldEventCandidate[];
  eventsOff?: WorldEventsOffReason | null;
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
    pairs: record.pairs ?? data.pairs,
    leftOut: record.leftOut ?? data.leftOut,
    pairsOff: record.pairsOff === undefined ? data.pairsOff : record.pairsOff,
    places: record.places ?? data.places,
    placesOff: record.placesOff === undefined ? data.placesOff : record.placesOff,
    objects: record.objects ?? data.objects,
    terms: record.terms ?? data.terms,
    objectsOff: record.objectsOff === undefined ? data.objectsOff : record.objectsOff,
    termsOff: record.termsOff === undefined ? data.termsOff : record.termsOff,
    events: record.events ?? data.events,
    eventsOff: record.eventsOff === undefined ? data.eventsOff : record.eventsOff,
    steps: [...data.steps, record.step],
    items: [...data.items, ...record.items],
    droppedQuotes: [...data.droppedQuotes, ...record.droppedQuotes],
    droppedSources: [...data.droppedSources, ...record.droppedSources],
    pending: null,
  };
}

/**
 * Отказы шага страницы без платного вызова - свои коды у типа (`runPageStep`). Это коды шага
 * (`WORLD_*_KEY_TAKEN`, `WORLD_*_NOT_FOUND`), а не отсева на выборе: тот живёт в `RULES`
 * (`world-write.dossier-entities.ts`, `*_KEY_TAKEN`/`*_BELOW_MIN_CHAPTERS`) и у событий - в
 * `world-write.events.ts`; две таблицы называют разное и не сводятся в одну.
 */
const PAGE_REFUSALS: Record<WorldListType, { taken: string; notFound: string }> = {
  place: { taken: WORLD_PLACE_KEY_TAKEN, notFound: WORLD_PLACE_NOT_FOUND },
  object: { taken: WORLD_OBJECT_KEY_TAKEN, notFound: WORLD_OBJECT_NOT_FOUND },
  term: { taken: WORLD_TERM_KEY_TAKEN, notFound: WORLD_TERM_NOT_FOUND },
  event: { taken: WORLD_EVENT_KEY_TAKEN, notFound: WORLD_EVENT_NOT_FOUND },
};

/** Контекст шага хода - общий у шагов, которым нужен цикл качества. */
interface WorldStepRun {
  row: ContentDraft;
  gate: WorldGate;
  step: number;
  context: WorldContext;
  pending: PendingWorldStep | null;
  ctx: LlmTaskContext;
  regen: { spec: WorldRegenSpec; index: number } | null;
}

/** Своё у типа в шаге страницы списка хода (`runPageStep`): сущность, коды отказа, вход и итог. */
interface RunPageStepSpec<T> {
  kind: WorldListType;
  entry: WorldDossierCandidate | undefined;
  refusals: { taken: string; notFound: string };
  input: (
    entry: WorldDossierCandidate,
    index: ChapterIndex,
    top: number | null,
  ) => WorldStepInput<T>;
  record: (
    entry: WorldDossierCandidate,
    result: Extract<QualityLoopResult<T>, { ok: true }>,
    source: WorldStepSource,
  ) => StepRecord;
}

/**
 * Шаги хода «Write World» (`F08-4a`; `features/F08-book-wiki/tech.md` §5): выбор героев и форм имени,
 * затем на каждого героя - страница и внешние блоки, затем страница каждой пары (`F08-8e`); каждый
 * шаг - циклом качества `F06-1` с
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
    private readonly mentions: WorldMentionsService,
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
    // Шаг 0 - выбор: только ему нужны известные события (подсказка ключа, `eventChoice`).
    const context = await this.contextOf(
      row,
      dossier,
      step === 0 && eventsMode(row.language, data.events) === 'on',
    );
    if (step === 0 && runMainCharacters(context).length === 0) {
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
    const position = stepOfData(data, step);
    const empty = { droppedQuotes: [], droppedSources: [] };
    // Номер шага вне всех списков хода: шага нет - свой код (`WORLD_STEP_OUT_OF_RUN`), не шаг события.
    // Ход его не достигает (`stepsTotalOf` кончает ход раньше), перегенерация - по шагу записанного пункта.
    if (position === null) {
      return {
        step: failedStep(step, 'event', null, WORLD_STEP_OUT_OF_RUN, null),
        items: [],
        ...empty,
      };
    }
    const { kind, candidate: at } = position;
    // Индекс глав - только выбору и странице: внешний шаг текста книги не читает.
    const quotes = () => chapterIndexOf(context);
    const fits = <T>(input: WorldStepInput<T>) => worldInputFits(this.llm, input);

    if (kind === 'select') {
      const base = runCharacters(context);
      // Места (`F08-12b`, Q1): места досье не на ключе героя анализа или сущности другого типа (`placesToChoose`).
      const placeBase = placesToChoose(
        context.language,
        data.places,
        context.dossier,
        context.entities,
        new Set((context.analysis.characters ?? []).map((c) => c.key)),
      );
      // Предметы и понятия (`F08-13b`, Q1): ключ, занятый героем, местом, сущностью другого типа
      // (у понятия - и предметом досье), - отсеян до платного шага; ключи пар - после выбора пар.
      const objectBase = objectsToChoose(
        context.language,
        { objects: data.objects, terms: data.terms },
        context.dossier,
        context.entities,
        new Set((context.analysis.characters ?? []).map((c) => c.key)),
      );
      const index = quotes();
      // События (`F08-13b-2`): выбор предлагает их сам, кроме старого хода и языка без эталона (Q7).
      const eventMode = eventsMode(context.language, data.events);
      // Сколько глав прочёл выбор (префикс, когда весь текст не влез): главы событий из ответа -
      // только из них (`F08-13b-3`, круг 4 `F08-13b-2`).
      const readOf = new Map<object, number>();
      const make = (count: number) => {
        const made = selectInput(
          context,
          base,
          index,
          {
            text: chaptersText(context.chapters.slice(0, count)) || 'none',
            partial: count < context.chapters.length,
            readChapters: count,
          },
          {
            places: placeBase.places,
            objects: objectBase.objects.free,
            terms: objectBase.terms.free,
            events: {
              on: eventMode === 'on',
              known: eventMode === 'on' ? context.knownEvents : [],
            },
          },
        );
        readOf.set(made, count);
        return made;
      };
      // Весь текст сначала; не влез - наибольший префикс глав, как у страницы.
      const input = await fittingInput(
        context.chapters.length,
        (count) => make(count ?? context.chapters.length),
        fits,
      );
      const result = input ? await this.loop(row, gate, input, step, pending, ctx, null) : null;
      if (result === null && input !== null) return null;
      const answer = result?.ok ? result.draft : null;
      const chosen = await this.candidatesOf(row.bookVersionId, context, base, answer, index);
      const choice = choosePairs(context, chosen, data.pairs);
      const pairKeys = new Set(choice.pairs.map((p) => p.key));
      // Места, предметы и понятия - одним отбором сущностей досье (`F08 | F08-13b` R1).
      const choose = <K extends WorldDossierType>(
        type: K,
        chosenOfType: WorldDossierChosen,
        previous: WorldDossierCandidate[] | null,
      ) =>
        this.dossierChoice(
          row.bookVersionId,
          context,
          type,
          entriesAfterPairs(chosenOfType, pairKeys),
          answer,
          index,
          previous,
        );
      const placeChoice = await choose(
        'place',
        { free: placeBase.places, taken: placeBase.taken },
        data.places,
      );
      const objectChoice = await choose('object', objectBase.objects, data.objects);
      const termChoice = await choose('term', objectBase.terms, data.terms);
      const eventChoice = await this.eventChoice(
        row.bookVersionId,
        context,
        eventMode,
        data.events,
        answer,
        pairKeys,
        (input && readOf.get(input)) ?? context.chapters.length,
      );
      const stepRecord =
        input === null
          ? failedStep(step, kind, null, DRAFT_TOO_LONG, null)
          : !result?.ok
            ? failedStep(step, kind, null, DRAFT_INVALID_RESPONSE, input.source)
            : doneStep(step, kind, null, result, result.remarks, input.source, answer?.fixes ?? []);
      return {
        step: stepRecord,
        items: [],
        candidates: chosen.candidates,
        ...choice,
        places: placeChoice.list,
        placesOff: placeChoice.off,
        objects: objectChoice.list,
        objectsOff: objectChoice.off,
        terms: termChoice.list,
        termsOff: termChoice.off,
        events: eventChoice.list,
        eventsOff: eventChoice.off,
        leftOut: [
          ...choice.leftOut,
          ...placeChoice.leftOut,
          ...objectChoice.leftOut,
          ...termChoice.leftOut,
          ...eventChoice.leftOut,
          ...organizationsSkipped(objectBase.organizations),
        ],
        ...empty,
      };
    }

    if (kind === 'pair') {
      return this.pairStep(row, gate, step, at ?? -1, context, data, pending, ctx, regen);
    }

    // Места, предметы, понятия и события - один шаг страницы со своим входом и итогом (R1).
    const run = { row, gate, step, context, pending, ctx, regen };
    if (kind === 'place') {
      return this.runPageStep(run, {
        kind,
        entry: runListOf(data, kind)?.[at ?? -1],
        refusals: PAGE_REFUSALS[kind],
        input: (entry, index, top) =>
          placeInput(context, entry, index, pageBook(context, entry, top), regen?.spec ?? null),
        record: (entry, result, source) => placeRecord(step, entry, result, source, regen !== null),
      });
    }

    if (isRunObjectType(kind)) {
      return this.runPageStep(run, {
        kind,
        entry: runListOf(data, kind)?.[at ?? -1],
        refusals: PAGE_REFUSALS[kind],
        input: (entry, index, top) =>
          objectInput(
            context,
            kind,
            entry,
            index,
            pageBook(context, entry, top),
            regen?.spec ?? null,
          ),
        record: (entry, result, source) =>
          objectRecord(step, kind, entry, result, source, regen !== null),
      });
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
      const input = await fittingInput(candidate.mentions.chapters.length, make, fits);
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
   * Шаг пары `at` (`F08-8e`): без платного вызова - если героя пары нет в мире версии героем, ключ
   * занят сущностью другого типа или новая пара не проходит условие заведения по сохранённому
   * присутствию (решения арбитра `F08 | F08-8e-1` Q1, Q4); перед новой парой до первого успешного - пересчёт присутствия
   * версии. Перегенерация пункта - у заведённой пары, без этих проверок.
   */
  private async pairStep(
    row: ContentDraft,
    gate: WorldGate,
    step: number,
    at: number,
    context: WorldContext,
    data: WorldWriteData,
    pending: PendingWorldStep | null,
    ctx: LlmTaskContext,
    regen: { spec: WorldRegenSpec; index: number } | null,
  ): Promise<StepRecord | null> {
    const pair = data.pairs?.[at];
    const a = pair ? data.candidates?.find((c) => c.key === pair.a) : undefined;
    const b = pair ? data.candidates?.find((c) => c.key === pair.b) : undefined;
    const fail = (reason: string, source: WorldStepSource | null = null): StepRecord => ({
      step: failedStep(step, 'pair', pair?.key ?? null, reason, source),
      items: [],
      droppedQuotes: [],
      droppedSources: [],
    });
    if (!pair || !a || !b) return fail(DRAFT_DATA_INVALID);
    // Героя пары формы имени не нашли ни в одной главе: сравнивать не по чему (как у страницы героя).
    if (a.mentions.chapters.length === 0 || b.mentions.chapters.length === 0) {
      return fail(WORLD_CHARACTER_NOT_FOUND);
    }
    // Оплаченный текст этого шага уже сохранён (обрыв после вызова): проверки он прошёл до оплаты.
    const paid = pending !== null && pending.key === stepKey(step);
    if (!regen && !paid) {
      const refused = await this.pairRefusal(row, gate, pair, context, data);
      if (refused === RUN_GONE) return null;
      if (refused) return fail(refused);
    }
    const members: WorldPairMembers = { a, b };
    const chapters = pairChapters(pair, members);
    const index = chapterIndexOf(context);
    const make = (count: number | null) =>
      pairInput(
        context,
        pair,
        members,
        index,
        pairBook(context, chapters, count),
        regen?.spec ?? null,
      );
    const fits = <T>(input: WorldStepInput<T>) => worldInputFits(this.llm, input);
    const input = await fittingInput(chapters.length, make, fits);
    if (input === null) return fail(DRAFT_TOO_LONG);
    const result = await this.loop(row, gate, input, step, pending, ctx, regen);
    if (result === null) return null;
    if (!result.ok) return fail(DRAFT_INVALID_RESPONSE, input.source);
    return pairRecord(step, context.language, pair, members, result, input.source);
  }

  /**
   * Шаг страницы сущности со списком хода - места (`F08-12b`), предмета или понятия (`F08-13b`) из
   * досье и события из ответа выбора (`F08-13b-2`), одно правило (решение арбитра `F08 | F08-13b` R1):
   * страница этапом страницы по главам сущности (не влезло - сначала главы, названные выбором, затем
   * с наибольшим числом упоминаний, и краткое содержание глав досье, `pageBook`). Без платного вызова:
   * ключ заняли сущностью другого типа после выбора (`refusals.taken`), у сущности нет ни одной главы
   * (`refusals.notFound`). Вход и итог - свои у типа (`spec`).
   */
  private async runPageStep<T>(
    run: WorldStepRun,
    spec: RunPageStepSpec<T>,
  ): Promise<StepRecord | null> {
    const { row, gate, step, context, pending, ctx, regen } = run;
    const entry = spec.entry;
    const fail = (reason: string, source: WorldStepSource | null = null): StepRecord => ({
      step: failedStep(step, spec.kind, entry?.key ?? null, reason, source),
      items: [],
      droppedQuotes: [],
      droppedSources: [],
    });
    if (!entry) return fail(DRAFT_DATA_INVALID);
    if (dossierKeyTaken(spec.kind, context.entities.get(entry.key)?.type)) {
      return fail(spec.refusals.taken);
    }
    if (entry.mentions.chapters.length === 0) return fail(spec.refusals.notFound);
    const index = chapterIndexOf(context);
    const fits = <I>(input: WorldStepInput<I>) => worldInputFits(this.llm, input);
    const input = await fittingInput(
      entry.mentions.chapters.length,
      (top) => spec.input(entry, index, top),
      fits,
    );
    if (input === null) return fail(DRAFT_TOO_LONG);
    const result = await this.loop(row, gate, input, step, pending, ctx, regen);
    if (result === null) return null;
    if (!result.ok) return fail(DRAFT_INVALID_RESPONSE, input.source);
    return spec.record(entry, result, input.source);
  }

  /**
   * Сущности шага выбора с формами и присутствием - общее у героев и мест (решение арбитра
   * `F08 | F08-12b` R4): имя и формы из ответа выбора (нет ответа - имя входа), сохранённые формы
   * первыми (их мог дописать редактор), формы досье и глоссария (`formsOf`, только стоящие в тексте),
   * исключения форм и исключённые главы сохранённой сущности (`F08-8a`) - тем же правилом, что
   * пересчёт; присутствие по текстам глав - в памяти, без записи (R2), с общими главами входа.
   */
  private async countedOf<T extends { key: string; name: string }>(
    bookVersionId: string,
    context: WorldContext,
    base: readonly T[],
    found: (key: string) => { name: string; aliases: string[] } | undefined,
    formsOf: (entry: T) => string[],
  ): Promise<{
    entries: Array<T & { name: string; aliases: string[]; mentions: CandidateMentions }>;
    coPresence: ReadonlyMap<string, Record<string, number[]>>;
    /** Главы, исключённые редактором у форм сохранённой сущности ключа (`F08-8a`). */
    excludedChapters: ReadonlyMap<string, number[]>;
  }> {
    if (base.length === 0) {
      return { entries: [], coPresence: new Map(), excludedChapters: new Map() };
    }
    const exclusions = await this.prisma.bookWorldEntity.findMany({
      where: { bookVersionId, key: { in: base.map((e) => e.key) } },
      select: { key: true, aliasExclusions: true, aliasChapterExclusions: true },
      take: BOOK_WORLD_LIMITS.entities,
    });
    const byKey = new Map(exclusions.map((e) => [e.key, e]));
    const named = base.map((entry) => {
      const answer = found(entry.key);
      const stored = context.entities.get(entry.key);
      const row = byKey.get(entry.key);
      return {
        entry,
        key: entry.key,
        name: answer?.name ?? stored?.name ?? entry.name,
        aliases: [
          ...new Set([...(stored?.aliases ?? []), ...(answer?.aliases ?? []), ...formsOf(entry)]),
        ].slice(0, BOOK_WORLD_LIMITS.aliases),
        exclusions: Array.isArray(row?.aliasExclusions)
          ? row.aliasExclusions.filter((x): x is string => typeof x === 'string')
          : [],
        chapterExclusions: row ? readAliasChapterExclusions(row.aliasChapterExclusions) : null,
      };
    });
    const counted = countCandidates(context.chapters, named);
    return {
      entries: named.map((n) => {
        const m = counted.get(n.key);
        return {
          ...n.entry,
          name: n.name,
          aliases: n.aliases,
          mentions: { chapters: m?.chapters ?? [], perChapter: m?.perChapter ?? {} },
        };
      }),
      coPresence: new Map(named.map((n) => [n.key, counted.get(n.key)?.coPresence ?? {}])),
      // Исключения ставил редактор у сохранённой сущности - и формы берутся её, а не новое название из
      // ответа выбора: его в тексте обычно нет, исключений у него нет, и пересечение было бы пустым.
      excludedChapters: new Map(
        named.map((n) => {
          const stored = context.entities.get(n.key);
          return [
            n.key,
            chaptersExcludedForAllForms({
              key: n.key,
              name: stored?.name ?? null,
              aliases: stored?.aliases ?? [],
              aliasExclusions: n.exclusions,
              aliasChapterExclusions: n.chapterExclusions,
            }),
          ];
        }),
      ),
    };
  }

  /**
   * События после выбора (`F08-13b-2`, решения арбитра `F08 | F08-13b` Q2-Q4, Q7): кандидатов даёт
   * ответ выбора, не досье. Ключ - `pickEvents` (ключ мира другой версии или латиница; занятый ключ -
   * `EVENT_KEY_TAKEN` до платного шага); формы - ответа выбора и сохранённой сущности; главы - формы
   * названия в тексте ∪ главы ответа (`eventMentions`); без главы - отсечено, потолок - `selectEvents`.
   * Старый ход - прежний список; язык без эталона - пусто и причина выключения.
   */
  private async eventChoice(
    bookVersionId: string,
    context: WorldContext,
    mode: ReturnType<typeof eventsMode>,
    previous: WorldEventCandidate[] | null,
    answer: WorldSelectDraft | null,
    pairKeys: ReadonlySet<string>,
    readChapters: number,
  ): Promise<{
    list: WorldEventCandidate[];
    leftOut: WorldSkip[];
    off: WorldEventsOffReason | null;
  }> {
    if (mode === 'old') return { list: previous ?? [], leftOut: [], off: null };
    if (mode === 'language') return { list: [], leftOut: [], off: EVENTS_OFF };
    // Ключи героев анализа, сущностей досье любого вида и пар хода: событие на них не садится.
    const taken = new Set<string>([
      ...(context.analysis.characters ?? []).map((c) => c.key),
      ...dossierEntityKeys(context.dossier),
      ...pairKeys,
    ]);
    // Латиница по названию оригинала - только на переводе (Q3-1): на исходнике это название версии.
    const picked = pickEvents(
      answer?.events ?? [],
      new Set(context.knownEvents.map((e) => e.key)),
      taken,
      context.entities,
      context.language !== originalLanguageCode(context.originalLanguage),
    );
    const answered = new Map(picked.free.map((e) => [e.key, e]));
    const { entries, excludedChapters } = await this.countedOf(
      bookVersionId,
      context,
      picked.free,
      (key) => answered.get(key),
      () => [],
    );
    // Главы ответа - только прочитанные выбором главы версии (префикс, `readChapters`): черновик выбора
    // мог быть сохранён и прочитан не этим кодом, а главу вне префикса модель не читала.
    const inVersion = new Set(context.chapters.slice(0, readChapters).map((c) => c.number));
    const counted = entries.map((e) => ({
      key: e.key,
      name: e.name,
      aliases: e.aliases,
      mentions: eventMentions(
        e.mentions,
        (answered.get(e.key)?.chapters ?? []).filter((n) => inVersion.has(n)),
        excludedChapters.get(e.key) ?? [],
      ),
    }));
    const selection = selectEvents(counted);
    return {
      list: selection.list,
      leftOut: [...picked.leftOut, ...selection.skipped],
      off: null,
    };
  }

  /**
   * Места, предметы или понятия после выбора (`F08-12b`, `F08-13b`, R1): формы - ответа выбора,
   * сохранённые, название досье и глоссарий того же ключа (`dossierEntityForms`); присутствие -
   * `countedOf`; занятые ключи, порог и потолок - `chooseDossierEntities`. У старого хода и на языке
   * без эталона типа `chosen.free` пуст (`placesToChoose`, `objectsToChoose`): подсчёта нет.
   */
  private async dossierChoice<K extends WorldDossierType>(
    bookVersionId: string,
    context: WorldContext,
    type: K,
    chosen: WorldDossierChosen,
    answer: WorldSelectDraft | null,
    index: ChapterIndex,
    previous: WorldDossierCandidate[] | null,
  ): Promise<ReturnType<typeof chooseDossierEntities<K>>> {
    const folded = foldedVersion(index);
    const forms = selectForms(answer, WORLD_DOSSIER_LISTS[type]);
    const { entries } = await this.countedOf(
      bookVersionId,
      context,
      chosen.free,
      (key) => forms.find((a) => a.key === key),
      (e) => dossierEntityForms(e.key, type, context.dossier, context.glossary, folded),
    );
    const counted = entries.map((e) => ({
      key: e.key,
      name: e.name,
      aliases: e.aliases,
      mentions: e.mentions,
    }));
    return chooseDossierEntities(type, context.language, counted, chosen.taken, previous);
  }

  /**
   * Почему шаг пары не платит за вызов; `null` - платит. Перед новой парой, пока пересчёт присутствия
   * версии ни разу не сошёлся, - пересчёт (уточнение Q1): условие заведения читает сохранённое
   * присутствие героев, которых ход только что записал; не сошёлся - `WORLD_MENTIONS_MOVED` только
   * этой паре, следующая новая пара пересчитает снова; сошёлся - отметка `mentionsRecounted`, дальше
   * без пересчёта. Заведённая пара условие не проходит (R1) - ей пересчёт не нужен. Несвязанная в анализе
   * пара без общих глав (новая и заведённая) - `WORLD_PAIR_NOT_FOUNDED` до пересчёта и чтения: ядра у неё
   * нет (Q1 `F08 | F08-8e-4`); перегенерацию и оплаченный шаг отказ не касается (Q1-бис).
   */
  private async pairRefusal(
    row: ContentDraft,
    gate: WorldGate,
    pair: WorldPairCandidate,
    context: WorldContext,
    data: WorldWriteData,
  ): Promise<string | null> {
    const bookVersionId = row.bookVersionId;
    const stored = context.entities.get(pair.key);
    // Правила `world-refs.ts`: ключ другого типа ход не берёт (как отбор пар), без героев пары запись
    // отбила бы её 400 (`checkWorldPair`).
    if (pairKeyTaken(stored?.type)) return WORLD_PAIR_KEY_TAKEN;
    if (missingPairMembers([pair.a, pair.b], storedCharacterKeys(context.entities)).length > 0) {
      return WORLD_PAIR_MEMBER_MISSING;
    }
    // Несвязанная пара без общих глав (заведённая - R1 её не отсеивает): ядра у такой пары нет
    // (общие главы ≥1, Q2 `F08 | F08-8c`), сравнивать не по чему - шаг без вызова (Q1 `F08 | F08-8e-4`).
    if (!pair.linked && pair.chapters.length === 0) return WORLD_PAIR_NOT_FOUNDED;
    // Заведённая пара условие заведения повторно не проходит (решение `F08 | F08-8c-1` R1, Q4).
    if (stored) return null;
    if (!data.mentionsRecounted) {
      if ((await this.mentions.recountVersion(bookVersionId)).status === 'retry') {
        return WORLD_MENTIONS_MOVED;
      }
      const marked = await this.fields.mutate(row, gate, (current) => ({
        ...current,
        mentionsRecounted: true,
      }));
      // Ход ушёл (отменён, отброшен) во время пересчёта: платного вызова не будет.
      if (marked === null) return RUN_GONE;
    }
    const evidence = pairEvidenceOf(
      context.analysis.characters,
      await savedMentionsOf(this.prisma, bookVersionId, [pair.a, pair.b]),
    );
    return pairFounded(evidence(pair.a, pair.b)) ? null : WORLD_PAIR_NOT_FOUNDED;
  }

  /**
   * Кандидаты после выбора: имя и формы из ответа (нет ответа - имя анализа), формы и исключения
   * сохранённой сущности, присутствие по текстам глав - до страницы, в памяти; второстепенные ниже
   * порога глав - отсеянными (`BELOW_MIN_CHAPTERS`), общие главы кандидатов - вход отбора пар.
   */
  private async candidatesOf(
    bookVersionId: string,
    context: WorldContext,
    base: ReadonlyArray<WorldBaseCharacter>,
    answer: WorldSelectDraft | null,
    index: ChapterIndex,
  ): Promise<ChosenCandidates> {
    const folded = foldedVersion(index);
    // Формы - ответа модели (или сохранённые), плюс досье (имя, варианты, обращения к герою) и
    // глоссарий запуска (`tech.md` §4); каждая - только если стоит в тексте версии.
    const { entries: all, coPresence } = await this.countedOf(
      bookVersionId,
      context,
      base,
      (key) => selectForms(answer, 'characters').find((a) => a.key === key),
      (c) => dossierForms({ key: c.key, name: c.name }, context.dossier, context.glossary, folded),
    );
    // Второстепенный ниже порога глав на сайт не выйдет (`F08-8b`): страницу ему не пишут.
    const passes = (c: WorldCandidate) => worldRolePasses(c.role, c.mentions.chapters.length);
    return {
      candidates: all.filter(passes),
      leftOut: all
        .filter((c) => !passes(c))
        .map((c) => ({
          key: c.key,
          reason: 'BELOW_MIN_CHAPTERS' as const,
          names: [c.name],
          chapters: c.mentions.chapters.length,
        })),
      coPresence,
    };
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
        current: regenCurrent(stored, item),
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
            // Новое ТЗ — с отпечатком той «Внешности», по которой написано (решение `F08 | F08-11d-2`).
            basis: fresh.basis ?? null,
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

  /**
   * Версия, глоссарий, главы, анализ версии, сущности мира и названия всех версий книги; известные
   * события (`knownWorldEvents`) - только с `withEvents`: их читает один шаг выбора (/qa круг 2 13b-2).
   */
  async contextOf(row: ContentDraft, dossier: unknown, withEvents = false): Promise<WorldContext> {
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
    // Известные события - подсказка ключа выбору (`F08-13b-2`, Q3, Q3-2): своя версия, исходник, прочие.
    const knownEvents = withEvents
      ? await knownWorldEvents(this.prisma, row.bookVersionId, version.originalLanguage ?? '')
      : [];
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
      knownEvents,
    };
  }
}

/**
 * Пункты на блок ответа (общее у страницы героя и пары): неверные по импорту - не пишутся,
 * а идут пунктом `failed`/`IMPORT_INVALID`; остальные - с вердиктом по замечаниям блока.
 */
function blockItems<D extends { blocks: Partial<Record<WorldBlock, unknown>> }>(
  step: number,
  key: string,
  name: string,
  result: Extract<QualityLoopResult<D>, { ok: true }>,
): WorldItem[] {
  const invalid = invalidBlocks(result.remarks);
  const answered = result.review.kind === 'answered';
  const items: WorldItem[] = [];
  for (const [block, value] of Object.entries(result.draft.blocks) as Array<
    [WorldBlock, unknown]
  >) {
    const own = remarksOfBlock(result.remarks, block);
    items.push(
      invalid.has(block)
        ? {
            ...emptyItem(key, block, step),
            verdict: 'failed',
            remarks: own,
            review: result.review,
            outcome: 'none',
            failedReason: 'IMPORT_INVALID',
          }
        : {
            ...emptyItem(key, block, step),
            verdict: verdictOf(own, answered),
            remarks: own,
            review: result.review,
            value,
            name,
          },
    );
  }
  return items;
}

/** Итог шага пары: пункт на блок ответа, неверные по импорту - не пишутся (как у страницы героя). */
export function pairRecord(
  step: number,
  language: Language,
  pair: WorldPairCandidate,
  members: WorldPairMembers,
  result: Extract<QualityLoopResult<WorldPairDraft>, { ok: true }>,
  source: WorldStepSource,
): StepRecord {
  const name = result.draft.name ?? pairFallbackName(language, members);
  return {
    step: doneStep(step, 'pair', pair.key, result, result.remarks, source, result.draft.fixes),
    items: blockItems(step, pair.key, name, result),
    droppedQuotes: result.draft.droppedQuotes,
    droppedSources: [],
  };
}

/**
 * Что переписывает перегенерация пункта (CURRENT_BLOCK промпта): блок сохранённой сущности в виде пункта
 * (`entityBlock`: у места `kind` - пара вида и номера, R3), а пустой блок или сущности нет -
 * само предложение (/qa F08-12b: пустая пара `{kind: null, wikidataId: null}` не подменяет его).
 */
export function regenCurrent(
  stored: StoredWorldEntity | undefined,
  item: Pick<WorldItem, 'block' | 'value'>,
): unknown {
  const block = stored ? entityBlock(stored, item.block) : null;
  return block !== null && !blockIsEmpty(block) ? block : item.value;
}

/** Ответ шага страницы с ТЗ после кода (герой или место): блоки - значения пунктов. */
interface BriefPageDraft {
  name: string | null;
  blocks: Partial<Record<WorldBlock, unknown>>;
  fixes: WorldFix[];
  droppedQuotes: DroppedWorldQuote[];
  briefFor?: string | null;
}

/** Сущность записанного шага страницы: ключ, имя по умолчанию и формы имени из выбора. */
interface BriefPageSubject {
  key: string;
  name: string;
  aliases: string[];
}

/**
 * Пункт форм имени записанного шага страницы - общий у героя, места, предмета и понятия: формы из
 * выбора первыми; у перегенерации и без форм - пусто (формы не перегенерируются).
 */
function nameFormsItems(
  step: number,
  subject: BriefPageSubject,
  name: string,
  regen: boolean,
): WorldItem[] {
  return !regen && subject.aliases.length > 0
    ? [{ ...emptyItem(subject.key, 'aliases', step), value: subject.aliases, name }]
    : [];
}

/**
 * Пункты шага страницы с ТЗ - общие у героя и места (решение арбитра `F08 | F08-12b` R4): формы имени
 * из выбора первыми (не у перегенерации), пункт на блок, неверные по импорту - не пишутся; ТЗ - с
 * отпечатком основы (`briefBasisBlock`: «Внешность» героя, «Описание» места), а основа, отбитая
 * импортом, снимает и ТЗ с кодом основы (решения `F08 | F08-11d` Q10, `F08 | F08-12b` Q2).
 */
function briefPageRecord<D extends BriefPageDraft>(
  step: number,
  kind: 'page' | 'place',
  subject: BriefPageSubject,
  result: Extract<QualityLoopResult<D>, { ok: true }>,
  source: WorldStepSource,
  regen: boolean,
): StepRecord {
  const name = result.draft.name ?? subject.name;
  const items: WorldItem[] = nameFormsItems(step, subject, name, regen);
  const basis = briefBasisBlock(kind === 'place' ? 'place' : 'character');
  const blocks = blockItems(step, subject.key, name, result);
  const lookRejected = blocks.some((i) => i.block === basis && i.outcome === 'none');
  const fixes = [...result.draft.fixes];
  if (lookRejected && blocks.some((i) => i.block === 'imageBrief')) {
    fixes.push({
      code: basis === 'description' ? 'BRIEF_WITHOUT_DESCRIPTION' : 'BRIEF_WITHOUT_APPEARANCE',
      path: 'imageBrief',
      note: `${basis} is not written: the brief is removed`,
    });
  }
  items.push(
    ...blocks.flatMap((i) =>
      i.block !== 'imageBrief'
        ? [i]
        : lookRejected
          ? []
          : [{ ...i, basis: result.draft.briefFor ?? null }],
    ),
  );
  return {
    step: doneStep(step, kind, subject.key, result, result.remarks, source, fixes),
    items,
    droppedQuotes: result.draft.droppedQuotes,
    droppedSources: [],
  };
}

/**
 * Вид и номер Wikidata места - один пункт `kind` (`WorldPlaceKindValue`, решение арбитра
 * `F08 | F08-12b` R3): правило сервера «номер только у реального места» - форма пункта, «Accept» не
 * соберёт запись, которую импорт отбивает 400. Замечание по номеру - замечание пункта `kind`.
 */
function withPlaceKind(
  result: Extract<QualityLoopResult<WorldPlaceDraft>, { ok: true }>,
): Extract<QualityLoopResult<BriefPageDraft>, { ok: true }> {
  const { kind, wikidataId } = result.draft.blocks;
  if (kind === undefined && wikidataId === undefined) return result;
  const value: WorldPlaceKindValue = { kind: kind ?? null, wikidataId: wikidataId ?? null };
  // Порядок блоков ответа сохраняется: пункт `kind` - на месте вида (или номера, если вида нет).
  const blocks: Partial<Record<WorldBlock, unknown>> = {};
  for (const [block, v] of Object.entries(result.draft.blocks)) {
    if (block === 'kind' || block === 'wikidataId') {
      if (!('kind' in blocks)) blocks.kind = value;
    } else blocks[block as WorldBlock] = v;
  }
  return {
    ...result,
    remarks: result.remarks.map((r) =>
      blockOfPath(r.where) === 'wikidataId' ? { ...r, where: `kind.${r.where}` } : r,
    ),
    draft: { ...result.draft, blocks },
  };
}

/** Итог шага места (`F08-12b`): как страница героя, ТЗ - по «Описанию», вид и номер - один пункт. */
export function placeRecord(
  step: number,
  place: WorldPlaceCandidate,
  result: Extract<QualityLoopResult<WorldPlaceDraft>, { ok: true }>,
  source: WorldStepSource,
  regen: boolean,
): StepRecord {
  return briefPageRecord(step, 'place', place, withPlaceKind(result), source, regen);
}

/** Итог страницы героя: пункт на блок (формы имени - из выбора), неверные по импорту - не пишутся. */
export function pageRecord(
  step: number,
  candidate: WorldCandidate,
  result: Extract<QualityLoopResult<WorldPageDraft>, { ok: true }>,
  source: WorldStepSource,
  regen: boolean,
): StepRecord {
  return briefPageRecord(step, 'page', candidate, result, source, regen);
}

/**
 * Итог шага предмета или понятия (`F08-13b`): формы названия из выбора первыми (не у перегенерации),
 * пункт на блок ответа, неверные по импорту - не пишутся; ТЗ нет (решение `F08 | F08-13` Q4).
 */
export function objectRecord(
  step: number,
  type: WorldRunObjectType,
  entry: WorldObjectCandidate,
  result: Extract<QualityLoopResult<WorldObjectDraft>, { ok: true }>,
  source: WorldStepSource,
  regen: boolean,
): StepRecord {
  const name = result.draft.name ?? entry.name;
  const items = [
    ...nameFormsItems(step, entry, name, regen),
    ...blockItems(step, entry.key, name, result),
  ];
  return {
    step: doneStep(step, type, entry.key, result, result.remarks, source, result.draft.fixes),
    items,
    droppedQuotes: result.draft.droppedQuotes,
    droppedSources: [],
  };
}
