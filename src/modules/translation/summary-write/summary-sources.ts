import { PrismaService } from '../../../prisma/prisma.service';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { htmlToParagraphs } from '../content-draft/content-draft.text';
import { DossierSummarySectionDto } from '../dto/dossier-data.dto';

/**
 * Источники хода пересказа (`F06-2`): план разделов досье, главы раздела и сохранённый полный.
 * До `F06-3` жили в `ContentDraftService` рядом с пошаговыми заготовками Summary `F05-10`; с их
 * снятием - здесь, у единственного потребителя.
 */

/** Раздел плана досье (`DossierV1.summaryPlan`): тип - DTO досье, форма меняется вместе с ним. */
export type PlanSection = Pick<DossierSummarySectionDto, 'number' | 'title' | 'chapters'>;

/** План разделов из данных досье: элемент не той формы пропускается (данные пишет код по форме). */
export function summaryPlanOf(dossierData: unknown): PlanSection[] {
  const plan = (dossierData as { summaryPlan?: unknown } | null)?.summaryPlan;
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((p) => {
    const e = p as Partial<PlanSection> | null;
    return e &&
      Number.isInteger(e.number) &&
      typeof e.title === 'string' &&
      Array.isArray(e.chapters)
      ? [
          {
            number: e.number as number,
            title: e.title,
            chapters: e.chapters.filter(Number.isInteger),
          },
        ]
      : [];
  });
}

/** В HTML есть видимый текст - той же нормализацией, что `@RichHtmlHasText` у сохранения. */
export const hasVisibleText = (html: string | null | undefined): boolean =>
  !!html && richHtmlText(html) !== '';

/** Сохранённый полный пересказ с видимым текстом абзацами; нет - `null`. */
export async function savedFull(prisma: PrismaService, versionId: string): Promise<string | null> {
  const row = await prisma.bookSummary.findUnique({
    where: { bookVersionId: versionId },
    select: { summary: true },
  });
  const text = row ? htmlToParagraphs(row.summary) : '';
  return text === '' ? null : text;
}

/**
 * Главы раздела плана по номерам - одна выборка на шаг раздела и его оценку (Р5 `F05-Rb`).
 * Пустые не отбрасываются: шаг по ним решает номер главы читалки.
 */
export function sectionChapters(
  prisma: PrismaService,
  versionId: string,
  section: Pick<PlanSection, 'chapters'>,
): Promise<Array<{ number: number; title: string; content: string }>> {
  return prisma.chapter.findMany({
    where: { bookVersionId: versionId, number: { in: section.chapters } },
    select: { number: true, title: true, content: true },
    orderBy: { number: 'asc' },
    take: section.chapters.length,
  });
}
