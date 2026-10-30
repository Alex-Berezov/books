import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TranslationRunLanguageStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { moneyUsd } from '../../llm/dto/llm-money';
import {
  TranslationReportCostDto,
  TranslationReportFinalCheckDto,
  TranslationReportFindingDto,
  TranslationReportLanguageDto,
  TranslationRunReportDto,
} from '../dto/translation-run-report-response.dto';
import {
  finalCheckBypassed,
  FinalCheckState,
  finalCheckStateOf,
} from '../final-check/final-check-state';
import { metadataStateOf } from '../metadata/metadata-state';
import {
  RUN_LANGUAGE_UNFINISHED,
  RUN_LANGUAGES_MAX,
  RUN_MAX_CHAPTERS,
} from './translation-run.constants';

/** Поля находки главы наружу: строки и числа по белому списку, длина строк - с пределом. */
const FINDING_STRINGS = [
  'chunkReason',
  'issue',
  'key',
  'form',
  'target',
  'fragment',
  'model',
] as const;
const FINDING_NUMBERS = ['seam', 'chunkIndex', 'block'] as const;
const FINDING_STRING_MAX = 500;

/**
 * Находки главы из JSON колонки - после проверки формы, а не сырьём: без кода находка не отдаётся,
 * поля - только известные и своего типа (`findings` пишут сборка, стыки, итоговая проверка
 * и черновик; оплаченная стоимость наружу не идёт - она в `costs`).
 */
export function reportFindings(value: Prisma.JsonValue): TranslationReportFindingDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f) => {
    if (!isRecord(f)) return [];
    if (typeof f.code !== 'string') return [];
    const out: TranslationReportFindingDto = { code: f.code };
    for (const k of FINDING_STRINGS) {
      if (typeof f[k] === 'string') out[k] = f[k].slice(0, FINDING_STRING_MAX);
    }
    for (const k of FINDING_NUMBERS) if (typeof f[k] === 'number') out[k] = f[k];
    // К тексту до повтора или правки куска (`F05-7v`): приглушается, во флаг главы не входит.
    if (f.stale === true) out.stale = true;
    if (Array.isArray(f.problems)) {
      out.problems = f.problems
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.slice(0, FINDING_STRING_MAX));
    }
    return [out];
  });
}

/**
 * Статус итоговой проверки языка (решение арбитра `F05 | F05-6`, 6c /fix круг 2, В4): `pending` -
 * незавершённый язык до неё не дошёл; `skipped` - не проводилась и не будет: этап `metadata` начат
 * до неё (запуск шёл во время выката, 6c В6) или язык закончился раньше её конца.
 */
function finalCheckStatus(
  l: { status: TranslationRunLanguageStatus; metadata: Prisma.JsonValue },
  final: FinalCheckState | null,
): TranslationReportFinalCheckDto['status'] {
  if (final?.done) return 'done';
  const open = (RUN_LANGUAGE_UNFINISHED as readonly string[]).includes(l.status);
  // Язык закончился (отменён, упал) раньше конца проверки - её уже не будет.
  if (!open) return 'skipped';
  if (final) return 'in_progress';
  return finalCheckBypassed(final, l.metadata) ? 'skipped' : 'pending';
}

/**
 * Отчёт запуска перевода (`F05-6`, шаг 8). Стоимость - по этапам и моделям на весь запуск: вызовы
 * всех операций с `translationRunId` запуска (сам запуск, досье, глоссарии), итог - сумма `spentUsd`
 * тех же операций; вызовы без итоговой стоимости - отдельной строкой «в полёте» вне итога (решение
 * арбитра `F05 | F05-6`, 6c В8). Денег по языкам нет: у вызова LLM языка нет.
 */
@Injectable()
export class TranslationRunReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(id: string): Promise<TranslationRunReportDto> {
    const run = await this.prisma.translationRun.findUnique({
      where: { id },
      select: { id: true, bookVersionId: true },
    });
    if (!run) throw new NotFoundException('Translation run not found');
    const ofRun = { operation: { translationRunId: id } };
    const [languages, chunks, chapters, calls, inFlight, spent] = await Promise.all([
      this.prisma.translationRunLanguage.findMany({
        where: { runId: id },
        select: {
          id: true,
          language: true,
          status: true,
          reason: true,
          reasonText: true,
          bookVersionId: true,
          draftCreatedAt: true,
          flaggedChunks: true,
          flaggedChapters: true,
          metadata: true,
          finalCheck: true,
        },
        orderBy: { language: 'asc' },
        take: RUN_LANGUAGES_MAX,
      }),
      // Строк не больше, чем языков × статусов × причин × попыток: группировка, а не выборка кусков.
      this.prisma.translationChunk.groupBy({
        by: ['runLanguageId', 'status', 'flagReason', 'attempts'],
        where: { runLanguage: { runId: id } },
        _count: { _all: true },
      }),
      this.prisma.translationChapter.findMany({
        where: { runLanguage: { runId: id } },
        select: {
          runLanguageId: true,
          chapterNumber: true,
          status: true,
          flagReason: true,
          seamIndex: true,
          length: true,
          lengthLimit: true,
          chapterId: true,
          writtenHash: true,
          rewriteRefusal: true,
          findings: true,
        },
        orderBy: { chapterNumber: 'asc' },
        take: RUN_MAX_CHAPTERS * RUN_LANGUAGES_MAX,
      }),
      // Строк не больше, чем этапов × моделей: группировка, а не выборка вызовов.
      this.prisma.llmCall.groupBy({
        by: ['stage', 'actualModel'],
        where: { ...ofRun, costUsd: { not: null } },
        _sum: { costUsd: true },
        _count: { _all: true },
      }),
      this.prisma.llmCall.aggregate({
        where: { ...ofRun, costUsd: null },
        _sum: { reservedUsd: true },
        _count: { _all: true },
      }),
      this.prisma.llmOperation.aggregate({
        where: { translationRunId: id },
        _sum: { spentUsd: true },
      }),
    ]);
    const zero = new Prisma.Decimal(0);
    const costs: TranslationReportCostDto[] = calls
      .map((c) => ({
        stage: c.stage,
        model: c.actualModel,
        calls: c._count._all,
        costUsd: moneyUsd(c._sum.costUsd ?? zero),
      }))
      .sort(
        (a, b) => a.stage.localeCompare(b.stage) || (a.model ?? '').localeCompare(b.model ?? ''),
      );
    return {
      id: run.id,
      bookVersionId: run.bookVersionId,
      languages: languages.map((l): TranslationReportLanguageDto => {
        const own = chunks.filter((c) => c.runLanguageId === l.id);
        const flagged = new Map<string, number>();
        for (const c of own) {
          if (c.status !== 'flagged' || c.flagReason === null) continue;
          flagged.set(c.flagReason, (flagged.get(c.flagReason) ?? 0) + c._count._all);
        }
        const rows = chapters.filter((c) => c.runLanguageId === l.id);
        const final = finalCheckStateOf(l.finalCheck);
        return {
          language: l.language,
          status: l.status,
          reason: l.reason,
          reasonText: l.reasonText,
          draftVersionId: l.bookVersionId,
          draftCreatedAt: l.draftCreatedAt?.toISOString() ?? null,
          flaggedChunks: l.flaggedChunks,
          flaggedChapters: l.flaggedChapters,
          authorFromGlossary: metadataStateOf(l.metadata)?.result?.authorFromGlossary ?? null,
          chunks: {
            total: own.reduce((sum, c) => sum + c._count._all, 0),
            retries: own.reduce((sum, c) => sum + Math.max(c.attempts - 1, 0) * c._count._all, 0),
            flagged: [...flagged].map(([reason, count]) => ({ reason, count })),
          },
          chapters: rows.map((c) => ({
            number: c.chapterNumber,
            status: c.status,
            flagReason: c.flagReason,
            seamIndex: c.seamIndex,
            length: c.length,
            lengthLimit: c.lengthLimit,
            chapterId: c.chapterId,
            rewriteRefusal: c.rewriteRefusal,
            findings: reportFindings(c.findings),
          })),
          notWrittenChapters: rows
            .filter((c) => c.status === 'flagged')
            .map((c) => c.chapterNumber),
          // Номер занят чужой главой (`markSkipped`, решение арбитра `F05 | F05-6`, 6b В2) - не
          // записанная переводом глава (6c /fix круг 2, В5).
          writtenChapters: rows.filter((c) => c.status === 'written' && c.writtenHash !== null)
            .length,
          takenChapters: rows
            .filter((c) => c.status === 'written' && c.writtenHash === null)
            .map((c) => c.chapterNumber),
          finalCheck: {
            status: finalCheckStatus(l, final),
            missingChapters: final?.code?.missing ?? [],
            chaptersChecked: final?.chapters.filter((c) => c.model !== '').length ?? 0,
          },
        };
      }),
      costs,
      inFlight: {
        calls: inFlight._count._all,
        reservedUsd: moneyUsd(inFlight._sum.reservedUsd ?? zero),
      },
      totalUsd: moneyUsd(spent._sum.spentUsd ?? zero),
    };
  }
}
