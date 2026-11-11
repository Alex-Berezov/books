import { ContentDraftKind, LlmOperationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { moneyUsd } from '../../llm/dto/llm-money';
import { AnalysisItem, readAnalysisData } from '../analysis-write/analysis-write.data';
import {
  AUTOSTART_CANCELLED,
  AUTOSTART_FAILED,
  AUTOSTART_NOTHING_TO_START,
  AUTOSTART_KINDS,
} from '../autostart/content-autostart.constants';
import { ANALYSIS_REMARK_CODES, AnalysisRemarkCode } from '../draft-quality/text-checks';
import { TranslationRunAnalysisDto } from '../dto/translation-run-analysis.dto';
import { TranslationRunSummaryDto } from '../dto/translation-run-summary.dto';
import { hasText, readWriteData } from '../summary-write/summary-write.data';
import { RUN_LANGUAGES_MAX } from './translation-run.constants';

/** Операций раздела на язык и вид: автозапуск и ход (`F06-5`, решение арбитра `F06 | F06-5`, Р5). */
const SECTION_OPERATIONS_PER_LANGUAGE = 2;

/** Виды хода раздела, которые стартует автозапуск (`F06-5`, `F07-3b`) - общий список. */
const SECTION_KINDS = AUTOSTART_KINDS;

export interface RunLanguageRef {
  id: string;
  runId: string;
  bookVersionId: string | null;
}

type SectionOperation = {
  id: string;
  translationRunId: string | null;
  bookVersionId: string | null;
  status: LlmOperationStatus;
  pauseReason: TranslationRunSummaryDto['pauseReason'];
  skipReason: string | null;
  spentUsd: Prisma.Decimal;
};

type SectionDraft = {
  id: string;
  translationRunLanguageId: string | null;
  status: TranslationRunSummaryDto['status'];
  failedReason: string | null;
  operationId: string;
  data: Prisma.JsonValue;
};

const EMPTY = {
  plannedSections: null,
  sectionsDone: 0,
  fullDone: false,
  briefDone: false,
  flaggedTexts: 0,
  failedTexts: 0,
};

/**
 * Состояние раздела языка из его операций и строки хода (чистая функция, `runSections`). Строка
 * хода главнее: её статус и число текстов; строка `failed` отказа старта (у неё нет данных хода,
 * Р6) - «не начат» с причиной (`product.md` §5, §8 п.11). Без строки - причина пропуска;
 * операция автозапуска упала или снята - «не удалось»; закрыта без причины (версии нет) -
 * «не начат»; идёт - «ждёт старта». Причина есть у каждого «не начат» и «не удалось».
 */
export function summaryOf(
  own: readonly SectionOperation[],
  draft: SectionDraft | null,
): TranslationRunSummaryDto | null {
  if (own.length === 0 && !draft) return null;
  const spentUsd = spentOf(own);
  if (draft && draft.data !== null) {
    const op = own.find((o) => o.id === draft.operationId) ?? null;
    const data = readWriteData(draft.data);
    const written = (target: 'full' | 'brief') =>
      data.items.some((i) => i.target === target && hasText(i));
    return {
      status: draft.status,
      reason: draft.failedReason,
      draftId: draft.id,
      operationStatus: op?.status ?? null,
      pauseReason: op?.pauseReason ?? null,
      plannedSections: data.plannedSections,
      sectionsDone: data.items.filter((i) => i.target === 'section' && hasText(i)).length,
      fullDone: written('full'),
      briefDone: written('brief'),
      flaggedTexts: data.items.filter((i) => i.verdict === 'flags').length,
      failedTexts: data.items.filter((i) => i.verdict === 'failed').length,
      spentUsd,
    };
  }
  return { ...notStarted(own, draft), ...EMPTY, spentUsd };
}

/**
 * Раздел без данных хода (общий у пересказа и анализа). Строку отказа старта отбросил ручной старт
 * на вкладке - «отброшен», иначе «не начат» с её причиной; без строки - причина пропуска; операция
 * автозапуска упала или снята - «не удалось»; закрыта без причины - «не начат»; идёт - «ждёт старта».
 */
function notStarted(own: readonly SectionOperation[], draft: SectionDraft | null) {
  const base = { draftId: draft?.id ?? null, operationStatus: null, pauseReason: null };
  if (draft) {
    const status = draft.status === 'discarded' ? ('discarded' as const) : ('skipped' as const);
    return { ...base, status, reason: draft.failedReason };
  }
  const skipped = own.find((o) => o.skipReason !== null);
  if (skipped) return { ...base, status: 'skipped' as const, reason: skipped.skipReason };
  if (own.some((o) => o.status === 'cancelled')) {
    return { ...base, status: 'failed' as const, reason: AUTOSTART_CANCELLED };
  }
  if (own.some((o) => o.status === 'failed')) {
    return { ...base, status: 'failed' as const, reason: AUTOSTART_FAILED };
  }
  if (own.every((o) => o.status === 'done')) {
    return { ...base, status: 'skipped' as const, reason: AUTOSTART_NOTHING_TO_START };
  }
  return { ...base, status: 'pending' as const, reason: null };
}

const spentOf = (own: readonly SectionOperation[]): string =>
  moneyUsd(own.reduce((sum, o) => sum.add(o.spentUsd), new Prisma.Decimal(0)));

/** Метка «сверить факты» человеку и флаг момента шага - не находки модели (T174, п.3; `F07 | F07-3`). */
const NOT_MODEL_REMARKS: readonly AnalysisRemarkCode[] = ['EXTERNAL_CHECK', 'CORE_MISSING'];

/** Замечания, которые вкладка хода показывает как «Model flags»: коды ответа хода без меток. */
const SHOWN_REMARKS = new Set<string>(
  ANALYSIS_REMARK_CODES.filter((c) => !NOT_MODEL_REMARKS.includes(c)),
);

/**
 * Блок с отметкой модели - то же правило, что у вкладки хода (T189, решение арбитра `T189`):
 * вердикт `flags` и хотя бы одно показанное замечание. Ответ хода отдаёт только
 * `ANALYSIS_REMARK_CODES` (`remarksDto`), вкладка снимает метки (`shownRemarks`) и пишет
 * «Model flags» при непустом остатке (`ItemCheck`); `flags` без замечаний - не в счёте.
 */
const isModelFlagged = (
  item: Pick<AnalysisItem, 'verdict' | 'remarks' | 'outcome' | 'failedReason'>,
): boolean =>
  item.verdict === 'flags' &&
  // «Nothing to add» вкладка показывает без отметки проверки (`isNothingToAdd`).
  !(item.outcome === 'none' && item.failedReason === null) &&
  item.remarks.some((r) => SHOWN_REMARKS.has(r.code));

/**
 * Состояние анализа языка (`F07-3b`, решение арбитра `F07 | F07-3b`, В2) - как `summaryOf`, но
 * единица хода - шаг, счёт - блоки с флагами и упавшие; `coreReady` - живой `BookAnalysis.hasCore`
 * версии языка, а не флаг шага `CORE_MISSING`.
 */
export function analysisOf(
  own: readonly SectionOperation[],
  draft: SectionDraft | null,
  coreReady: boolean,
): TranslationRunAnalysisDto | null {
  if (own.length === 0 && !draft) return null;
  const spentUsd = spentOf(own);
  if (draft && draft.data !== null) {
    const op = own.find((o) => o.id === draft.operationId) ?? null;
    const data = readAnalysisData(draft.data);
    const items = data.items.filter((i) => !('broken' in i));
    return {
      status: draft.status,
      reason: draft.failedReason,
      draftId: draft.id,
      operationStatus: op?.status ?? null,
      pauseReason: op?.pauseReason ?? null,
      stepsDone: data.steps.length,
      stepsTotal: data.stepsTotal,
      flaggedItems: items.filter(isModelFlagged).length,
      failedItems: items.filter((i) => i.verdict === 'failed').length,
      coreReady,
      spentUsd,
    };
  }
  return {
    ...notStarted(own, draft),
    stepsDone: 0,
    stepsTotal: null,
    flaggedItems: 0,
    failedItems: 0,
    coreReady,
    spentUsd,
  };
}

/** Разделы языка запуска: строки «Summary» и «Analysis» хода, истории и отчёта. */
export interface RunSections {
  summary: TranslationRunSummaryDto | null;
  analysis: TranslationRunAnalysisDto | null;
}

/**
 * Разделы по языку запуска (`F06-5`, `F07-3b`; `product.md` §5, §8 п.11): операции вида `draft`
 * запуска - автозапуск и ход (у перегенераций `translationRunId` нет, Р4) - по своему
 * `contentKind` (`null` не толкуется, решение арбитра `F07 | F07-3`), строка хода - по
 * `ContentDraft.translationRunLanguageId` и виду, ядро анализа - по версии языка. Нет ни операции,
 * ни строки вида - его поле `null` (раздел не включён или язык не дошёл до `done`). До трёх
 * запросов на страницу, а не на язык.
 */
export async function runSections(
  db: PrismaService,
  languages: readonly RunLanguageRef[],
): Promise<Map<string, RunSections>> {
  const result = new Map<string, RunSections>();
  if (languages.length === 0) return result;
  const runIds = [...new Set(languages.map((l) => l.runId))];
  const [operations, drafts] = await Promise.all([
    db.llmOperation.findMany({
      where: {
        translationRunId: { in: runIds },
        kind: 'draft',
        contentKind: { in: [...SECTION_KINDS] },
      },
      select: {
        id: true,
        translationRunId: true,
        bookVersionId: true,
        contentKind: true,
        status: true,
        pauseReason: true,
        skipReason: true,
        spentUsd: true,
      },
      take:
        runIds.length * RUN_LANGUAGES_MAX * SECTION_OPERATIONS_PER_LANGUAGE * SECTION_KINDS.length,
    }),
    db.contentDraft.findMany({
      where: {
        translationRunLanguageId: { in: languages.map((l) => l.id) },
        kind: { in: [...SECTION_KINDS] },
      },
      select: {
        id: true,
        translationRunLanguageId: true,
        kind: true,
        status: true,
        failedReason: true,
        operationId: true,
        data: true,
      },
      take: languages.length * SECTION_KINDS.length,
    }),
  ]);
  const ownOf = (l: RunLanguageRef, kind: ContentDraftKind) =>
    operations.filter(
      (o) =>
        o.contentKind === kind &&
        o.translationRunId === l.runId &&
        l.bookVersionId !== null &&
        o.bookVersionId === l.bookVersionId,
    );
  const draftOf = (l: RunLanguageRef, kind: ContentDraftKind) =>
    drafts.find((d) => d.translationRunLanguageId === l.id && d.kind === kind) ?? null;
  const analysed = languages.flatMap((l) =>
    l.bookVersionId !== null &&
    (ownOf(l, 'analysis_write').length > 0 || draftOf(l, 'analysis_write') !== null)
      ? [l.bookVersionId]
      : [],
  );
  const cores = analysed.length
    ? await db.bookAnalysis.findMany({
        where: { bookVersionId: { in: analysed } },
        select: { bookVersionId: true, hasCore: true },
        take: analysed.length,
      })
    : [];
  for (const l of languages) {
    const coreReady = cores.some((c) => c.bookVersionId === l.bookVersionId && c.hasCore);
    const summary = summaryOf(ownOf(l, 'summary_write'), draftOf(l, 'summary_write'));
    const analysis = analysisOf(
      ownOf(l, 'analysis_write'),
      draftOf(l, 'analysis_write'),
      coreReady,
    );
    if (summary || analysis) result.set(l.id, { summary, analysis });
  }
  return result;
}
