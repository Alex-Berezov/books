import { Language, LlmOperationKind, Prisma } from '@prisma/client';
import { moneyUsd } from '../../llm/dto/llm-money';
import { TranslationReportBreakdownDto } from '../dto/translation-run-report-response.dto';
import type { RunSections } from './run-sections';

/** Строка суммы вызовов: язык задачи исполнителя (пусто - вызов без задачи с языком) и вид операции. */
export interface RunCostRow {
  language: Language | null;
  kind: LlmOperationKind;
  cost: Prisma.Decimal | null;
}

/**
 * Суммы вызовов LLM запуска по языку задачи и виду операции. Язык у вызова - через задачу
 * исполнителя (`LlmCall.taskId` → `LlmTask.language`): шаги перевода языка, повторы его кусков
 * и его глоссарий ставятся задачами с языком. Вид операции не фильтруется здесь: что идёт в строку
 * языка, решает одно место - `runCostBreakdown` (операции разделов `draft` - нет, их траты
 * `summary.spentUsd` и `analysis.spentUsd` языка).
 */
export function runCostRows(
  prisma: Pick<Prisma.TransactionClient, '$queryRaw'>,
  runId: string,
): Promise<RunCostRow[]> {
  return prisma.$queryRaw<RunCostRow[]>`
    SELECT t."language" AS "language", o."kind" AS "kind", SUM(c."costUsd") AS "cost"
    FROM "LlmCall" c
    JOIN "LlmOperation" o ON o."id" = c."operationId"
    LEFT JOIN "LlmTask" t ON t."id" = c."taskId"
    WHERE o."translationRunId" = ${runId}
      AND c."costUsd" IS NOT NULL
    GROUP BY t."language", o."kind"`;
}

/** Виды операций, чьи вызовы с языком - перевод этого языка: сам запуск и повторы кусков. */
const TRANSLATION_KINDS: ReadonlySet<LlmOperationKind> = new Set([
  'translation_run',
  'translation_retry',
]);

/**
 * Разбивка трат запуска (экран отчёта перевода): перевод и глоссарий каждого языка, досье и
 * остаток. Языки - в порядке `languages`; язык без вызовов - нули. Глоссарий языка вне запуска -
 * в досье. Остаток - то, что есть в итоге запуска `totalUsd`, но не попало ни в одну строку (вызовы
 * без задачи с языком запуска, прочие виды операций, траты Summary и Analysis, не показанные
 * в строке языка - `sectionsUsd`, - и вызовы, закрытые между чтениями отчёта): так строки экрана
 * всегда сходятся с итогом. Отрицательный остаток (вызов закрылся между чтениями в другую
 * сторону) - ноль, а не минус.
 */
export function runCostBreakdown(
  rows: RunCostRow[],
  languages: Language[],
  totals: { totalUsd: Prisma.Decimal; sectionsUsd: Prisma.Decimal },
): TranslationReportBreakdownDto {
  const zero = new Prisma.Decimal(0);
  const translation = new Map<Language, Prisma.Decimal>();
  const glossary = new Map<Language, Prisma.Decimal>();
  let dossier = zero;
  let attributed = zero;
  const add = (map: Map<Language, Prisma.Decimal>, language: Language, cost: Prisma.Decimal) =>
    map.set(language, (map.get(language) ?? zero).add(cost));
  for (const row of rows) {
    const cost = new Prisma.Decimal(row.cost ?? 0);
    const ofRun = row.language !== null && languages.includes(row.language);
    if (row.kind === 'dossier') {
      if (ofRun) add(glossary, row.language as Language, cost);
      else dossier = dossier.add(cost);
    } else if (TRANSLATION_KINDS.has(row.kind) && ofRun) {
      add(translation, row.language as Language, cost);
    } else {
      continue;
    }
    attributed = attributed.add(cost);
  }
  const rest = totals.totalUsd.sub(attributed).sub(totals.sectionsUsd);
  return {
    languages: languages.map((language) => ({
      language,
      translationUsd: moneyUsd(translation.get(language) ?? zero),
      glossaryUsd: moneyUsd(glossary.get(language) ?? zero),
    })),
    dossierUsd: moneyUsd(dossier),
    unattributedUsd: moneyUsd(rest.isNegative() ? zero : rest),
  };
}

/** Траты Summary, Analysis и World, показанные в строках языков отчёта (`summary.spentUsd`, `analysis.spentUsd`, `world.spentUsd`). */
export function sectionsSpent(sections: ReadonlyMap<string, RunSections>): Prisma.Decimal {
  let sum = new Prisma.Decimal(0);
  for (const s of sections.values()) {
    if (s.summary) sum = sum.add(s.summary.spentUsd);
    if (s.analysis) sum = sum.add(s.analysis.spentUsd);
    if (s.world) sum = sum.add(s.world.spentUsd);
  }
  return sum;
}
