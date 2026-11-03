import { LlmOperationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { moneyUsd } from '../../llm/dto/llm-money';
import {
  AUTOSTART_CANCELLED,
  AUTOSTART_FAILED,
  AUTOSTART_NOTHING_TO_START,
} from '../autostart/content-autostart.constants';
import { TranslationRunSummaryDto } from '../dto/translation-run-summary.dto';
import { hasText, readWriteData } from '../summary-write/summary-write.data';
import { RUN_LANGUAGES_MAX } from './translation-run.constants';

/** Операций раздела на язык: автозапуск и ход (`F06-5`, решение арбитра `F06 | F06-5`, Р5). */
const SUMMARY_OPERATIONS_PER_LANGUAGE = 2;

/** Вид хода раздела, который стартует автозапуск (`F07-3` добавит анализ своим видом). */
const SUMMARY_KIND = 'summary_write' as const;

export interface RunLanguageRef {
  id: string;
  runId: string;
  bookVersionId: string | null;
}

type SummaryOperation = {
  id: string;
  translationRunId: string | null;
  bookVersionId: string | null;
  status: LlmOperationStatus;
  pauseReason: TranslationRunSummaryDto['pauseReason'];
  skipReason: string | null;
  spentUsd: Prisma.Decimal;
};

type SummaryDraft = {
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
 * Состояние раздела языка из его операций и строки хода (чистая функция, `runSummaries`). Строка
 * хода главнее: её статус и число текстов; строка `failed` отказа старта (у неё нет данных хода,
 * Р6) - «не начат» с причиной (`product.md` §5, §8 п.11). Без строки - причина пропуска;
 * операция автозапуска упала или снята - «не удалось»; закрыта без причины (версии нет) -
 * «не начат»; идёт - «ждёт старта». Причина есть у каждого «не начат» и «не удалось».
 */
export function summaryOf(
  own: readonly SummaryOperation[],
  draft: SummaryDraft | null,
): TranslationRunSummaryDto | null {
  if (own.length === 0 && !draft) return null;
  const spentUsd = moneyUsd(own.reduce((sum, o) => sum.add(o.spentUsd), new Prisma.Decimal(0)));
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
  const base = { draftId: draft?.id ?? null, operationStatus: null, pauseReason: null, ...EMPTY };
  // Строку отказа старта отбросил ручной старт на вкладке - так и показать, а не «не начат».
  if (draft) {
    const status = draft.status === 'discarded' ? 'discarded' : 'skipped';
    return { ...base, status, reason: draft.failedReason, spentUsd };
  }
  const skipped = own.find((o) => o.skipReason !== null);
  if (skipped) return { ...base, status: 'skipped', reason: skipped.skipReason, spentUsd };
  if (own.some((o) => o.status === 'cancelled')) {
    return { ...base, status: 'failed', reason: AUTOSTART_CANCELLED, spentUsd };
  }
  if (own.some((o) => o.status === 'failed')) {
    return { ...base, status: 'failed', reason: AUTOSTART_FAILED, spentUsd };
  }
  if (own.every((o) => o.status === 'done')) {
    return { ...base, status: 'skipped', reason: AUTOSTART_NOTHING_TO_START, spentUsd };
  }
  return { ...base, status: 'pending', reason: null, spentUsd };
}

/**
 * Ход раздела по языку запуска (`F06-5`; `product.md` §5, §8 п.11): операции вида `draft` запуска -
 * автозапуск и ход (у перегенераций `translationRunId` нет, Р4), строка хода - по
 * `ContentDraft.translationRunLanguageId` и виду. Нет ни операции, ни строки - `null` (без
 * «Write Summary» или язык не дошёл до `done`). Два запроса на страницу, а не на язык.
 */
export async function runSummaries(
  db: PrismaService,
  languages: readonly RunLanguageRef[],
): Promise<Map<string, TranslationRunSummaryDto>> {
  const result = new Map<string, TranslationRunSummaryDto>();
  if (languages.length === 0) return result;
  const runIds = [...new Set(languages.map((l) => l.runId))];
  const [operations, drafts] = await Promise.all([
    db.llmOperation.findMany({
      where: { translationRunId: { in: runIds }, kind: 'draft' },
      select: {
        id: true,
        translationRunId: true,
        bookVersionId: true,
        status: true,
        pauseReason: true,
        skipReason: true,
        spentUsd: true,
      },
      take: runIds.length * RUN_LANGUAGES_MAX * SUMMARY_OPERATIONS_PER_LANGUAGE,
    }),
    db.contentDraft.findMany({
      where: { translationRunLanguageId: { in: languages.map((l) => l.id) }, kind: SUMMARY_KIND },
      select: {
        id: true,
        translationRunLanguageId: true,
        status: true,
        failedReason: true,
        operationId: true,
        data: true,
      },
      take: languages.length,
    }),
  ]);
  for (const l of languages) {
    const own = operations.filter(
      (o) =>
        o.translationRunId === l.runId &&
        l.bookVersionId !== null &&
        o.bookVersionId === l.bookVersionId,
    );
    const draft = drafts.find((d) => d.translationRunLanguageId === l.id) ?? null;
    const summary = summaryOf(own, draft);
    if (summary) result.set(l.id, summary);
  }
  return result;
}
