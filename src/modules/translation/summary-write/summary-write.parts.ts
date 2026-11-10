import { Language, Prisma } from '@prisma/client';
import { StageCallEstimator } from '../../llm/llm.service';
import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import { ShapedRequest } from '../dossier/dossier.prompts';
import {
  dossierOf,
  glossaryNames,
  glossaryText,
  PartContext,
} from '../draft-quality/draft-context';
import { QualityLoopSpec } from '../draft-quality/quality-loop';
import { ChapterIndex, indexChapters } from '../draft-quality/quote-check';
import {
  checkDuplicate,
  checkJunk,
  checkLanguage,
  checkNames,
  checkQuotes,
  DraftRemark,
  SUMMARY_REVIEW_REMARK_CODES,
  wordCount,
} from '../draft-quality/text-checks';
import { StageModels } from '../run/run-models';
import {
  chaptersText,
  htmlToParagraphs,
  withChapterText,
} from '../content-draft/content-draft.text';
import { PlanSection, summaryPlanOf } from './summary-sources';
import { checkLength, checkStructure, sectionTitle, SummaryTarget } from './summary-checks';
import {
  SUMMARY_BRIEF_WRITE_STAGE,
  SUMMARY_FULL_WRITE_STAGE,
  SUMMARY_REVIEW_STAGE,
  SUMMARY_SECTION_WRITE_STAGE,
} from './summary-write.constants';
import {
  briefWriteRequest,
  fullWriteRequest,
  RedoInput,
  sectionWriteRequest,
  summaryReviewRequest,
  SUMMARY_WRITE_SHAPE,
} from './summary-write.prompts';

/**
 * Части хода пересказа (`F06-2`; `features/F06-summary-autofill/tech.md` §3-§4, `product.md` §2-§3):
 * входы автора и проверяющей, код-проверки части и оценка конвейера - одной сборкой на шаг
 * обработчика и на оценку старта, чтобы оценка считала те же запросы, что уйдут модели.
 */

export const AUTHOR_STAGE: Record<SummaryTarget, string> = {
  section: SUMMARY_SECTION_WRITE_STAGE,
  full: SUMMARY_FULL_WRITE_STAGE,
  brief: SUMMARY_BRIEF_WRITE_STAGE,
};

export type VersionChapter = { number: number; title: string; content: string };

/** Раздел плана хода целиком (номер - позиция, с `why`) - вход автора (круг 2: не по номеру модели). */
function planText(section: RunPlanSection): string {
  return JSON.stringify({
    number: section.number,
    title: section.title,
    chapters: section.chapters,
    why: section.why,
  });
}

/** Краткое содержание глав раздела из досье. */
function chapterSummaries(dossier: unknown, section: PlanSection): string {
  const own = new Set(section.chapters);
  const lines = (dossierOf(dossier).chapters ?? []).flatMap((c) =>
    typeof c.number === 'number' && own.has(c.number)
      ? [
          `[CHAPTER ${c.number}] ${typeof c.title === 'string' ? c.title : ''}\n${typeof c.summary === 'string' ? c.summary : ''}`,
        ]
      : [],
  );
  return lines.length > 0 ? lines.join('\n\n') : 'none';
}

/** Герои, хронология и место действия досье - вход полного (`tech.md` §3). */
function dossierFacts(dossier: unknown): string {
  const d = dossierOf(dossier);
  return JSON.stringify({
    characters: d.characters ?? [],
    chronology: d.chronology ?? [],
    setting: d.setting ?? null,
  });
}

/** Раздел плана хода: номер - позиция в плане, `why` - обоснование досье. */
export type RunPlanSection = PlanSection & { why: string };

/**
 * План досье для хода: номер раздела - позиция в плане (i + 1), номер модели не используется
 * (решение арбитра `F06 | F06-2`, круг 1, В4; как `joinPlans`). Порядок не меняется, данные
 * досье и `summaryPlanOf` - тоже.
 */
export function runPlanOf(dossierData: unknown): RunPlanSection[] {
  const raw = (dossierData as { summaryPlan?: unknown } | null)?.summaryPlan;
  if (!Array.isArray(raw)) return [];
  // Запись за записью тем же разбором, что `summaryPlanOf`: позиция и `why` - у той же записи,
  // что прошла разбор, а не у записи с тем же номером модели.
  return raw
    .flatMap((entry: unknown) => {
      const [section] = summaryPlanOf({ summaryPlan: [entry] });
      if (!section) return [];
      const why = (entry as { why?: unknown }).why;
      return [{ ...section, why: typeof why === 'string' ? why : '' }];
    })
    .map((section, i) => ({ ...section, number: i + 1 }));
}

/** Предел названия раздела (F04), как у `@MaxLength` ручки «Add section». */
const TITLE_MAX = SUMMARY_SECTION_LIMITS.title;

/** Старшая половина суррогатной пары в конце строки. */
const HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/;

/**
 * Название раздела под правила ручки «Add section» (`CreateBookSummarySectionDto`): простой текст
 * без `<` и `>`, не пустое, в предел F04 - ход пишет мимо DTO (круг 2). Пустое - «Глава N» по
 * первой главе плана.
 */
export function sectionTitleOf(raw: string, fallback: () => string): string {
  // Предел - в единицах UTF-16, как `@MaxLength` ручки; половина суррогатной пары не остаётся.
  const clean = (t: string) => {
    const cut = t.replace(/[<>]/g, '').trim().slice(0, TITLE_MAX);
    return (HIGH_SURROGATE_AT_END.test(cut) ? cut.slice(0, -1) : cut).trim();
  };
  return clean(raw) || clean(fallback());
}

/** Раздел плана на главах версии: главы с текстом, название кодом (§2.1), глава читалки (В5). */
export interface SectionSource {
  section: RunPlanSection;
  title: string;
  readerChapter: number | null;
  /** Главы раздела с видимым текстом; пусто - раздел без текста. */
  chapters: VersionChapter[];
}

export function sectionSource(
  section: RunPlanSection,
  chapters: readonly VersionChapter[],
  language: Language,
): SectionSource {
  const first = section.chapters[0];
  const readerChapter =
    first !== undefined && chapters.some((c) => c.number === first) ? first : null;
  // Название - по главам версии, а не по названию плана: оно как в читалке (§2.1, §8 п.12).
  const title = sectionTitleOf(sectionTitle(chapters, language) || section.title, () =>
    sectionTitle([{ number: first ?? section.number, title: '' }], language),
  );
  return {
    section,
    title,
    readerChapter,
    chapters: withChapterText(chapters),
  };
}

/** Вход части: запрос автору с переделкой и замечанием редактора, запрос проверяющей, проверки. */
export interface PartInput {
  target: SummaryTarget;
  author: (redo: RedoInput | null) => ShapedRequest;
  review: (text: string) => ShapedRequest;
  codeCheck: (text: string) => DraftRemark[];
  /** Раздел плана на главах версии (только `section`): номер, название и глава читалки текста. */
  source?: SectionSource;
}

/** Код-проверки §3, общие для частей: мусор, язык, имена, цитаты. */
function commonChecks(
  text: string,
  context: PartContext,
  quotes: ChapterIndex,
  subheadings: boolean,
): { remarks: DraftRemark[]; verbatim: string[] } {
  const names = glossaryNames(context.glossary);
  const quoted = checkQuotes(text, quotes);
  return {
    remarks: [
      ...checkJunk(text, { subheadings }),
      ...checkLanguage(text, context.language, names),
      ...checkNames(text, context.language, names),
      ...quoted.remarks,
    ],
    verbatim: quoted.verbatim,
  };
}

const chapterIndex = (chapters: readonly VersionChapter[]): ChapterIndex =>
  indexChapters(new Map(chapters.map((c) => [c.number, htmlToParagraphs(c.content)])));

/** Пустой индекс цитат - для оценки, где текста ещё нет. */
export const NO_QUOTES: ChapterIndex = indexChapters(new Map());

export function sectionPart(
  context: PartContext,
  source: SectionSource,
  editorNote: string | null,
): PartInput {
  const text = chaptersText(source.chapters);
  const words = wordCount(text);
  const quotes = chapterIndex(source.chapters);
  return {
    target: 'section',
    source,
    author: (redo) =>
      sectionWriteRequest({
        language: context.language,
        plan: planText(source.section),
        chapterSummaries: chapterSummaries(context.dossier, source.section),
        glossary: glossaryText(context),
        chaptersText: text,
        chaptersWords: words,
        redo,
        editorNote,
      }),
    review: (draft) =>
      summaryReviewRequest({
        target: 'section',
        language: context.language,
        source: text,
        context: chapterSummaries(context.dossier, source.section),
        glossary: glossaryText(context),
        text: draft,
      }),
    codeCheck: (draft) => [
      ...checkLength('section', draft, words),
      ...checkStructure({ target: 'section' }, draft),
      ...commonChecks(draft, context, quotes, false).remarks,
    ],
  };
}

/** Разделы для полного: название и текст абзацами. */
export type SectionText = { label: string; title: string; text: string };

export function fullPart(
  context: PartContext,
  sections: readonly SectionText[],
  quotes: ChapterIndex,
  editorNote: string | null,
): PartInput {
  const words = wordCount(sections.map((s) => s.text).join('\n\n'));
  const joined = sections.map((s) => `${s.title}\n\n${s.text}`).join('\n\n---\n\n');
  return {
    target: 'full',
    author: (redo) =>
      fullWriteRequest({
        language: context.language,
        dossier: dossierFacts(context.dossier),
        glossary: glossaryText(context),
        sections,
        sectionsWords: words,
        redo,
        editorNote,
      }),
    review: (draft) =>
      summaryReviewRequest({
        target: 'full',
        language: context.language,
        source: joined,
        context: dossierFacts(context.dossier),
        glossary: glossaryText(context),
        text: draft,
      }),
    codeCheck: (draft) => {
      const common = commonChecks(draft, context, quotes, true);
      return [
        ...checkLength('full', draft, words),
        ...checkStructure({ target: 'full', sections: sections.length }, draft),
        ...common.remarks,
        ...checkDuplicate(
          draft,
          sections.map((s) => ({ label: s.label, text: s.text })),
          common.verbatim,
        ),
      ];
    },
  };
}

export function briefPart(
  context: PartContext,
  full: string,
  quotes: ChapterIndex,
  editorNote: string | null,
): PartInput {
  const words = wordCount(full);
  return {
    target: 'brief',
    author: (redo) =>
      briefWriteRequest({
        language: context.language,
        glossary: glossaryText(context),
        full,
        fullWords: words,
        redo,
        editorNote,
      }),
    review: (draft) =>
      summaryReviewRequest({
        target: 'brief',
        language: context.language,
        source: full,
        context: '',
        glossary: glossaryText(context),
        text: draft,
      }),
    codeCheck: (draft) => {
      const common = commonChecks(draft, context, quotes, false);
      return [
        ...checkLength('brief', draft, words),
        ...checkStructure({ target: 'brief' }, draft),
        ...common.remarks,
        ...checkDuplicate(draft, [{ label: 'the full retelling', text: full }], common.verbatim),
      ];
    },
  };
}

/** Спецификация цикла качества части на моделях снимка операции (`tech.md` §3, Р5). */
export function loopSpec(
  part: PartInput,
  models: { author: StageModels; review: StageModels },
): QualityLoopSpec<string> {
  return {
    authorStage: AUTHOR_STAGE[part.target],
    authorShape: SUMMARY_WRITE_SHAPE,
    authorModels: models.author,
    authorRequest: (redo) => part.author(redo),
    readAuthor: (value) => (value as { text: string }).text.trim(),
    codeCheck: part.codeCheck,
    reviewStage: SUMMARY_REVIEW_STAGE,
    reviewCodes: SUMMARY_REVIEW_REMARK_CODES,
    reviewModels: models.review,
    reviewRequest: part.review,
  };
}

/** Оценщики этапов хода: три автора и проверяющая. */
export interface WriteEstimators {
  section: StageCallEstimator;
  full: StageCallEstimator;
  brief: StageCallEstimator;
  review: StageCallEstimator;
}

/** Проходов автора и проверки на текст: первый и одна переделка (U5, `tech.md` §6-§7). */
const PASSES = 2;

/**
 * Один текст сверху: (автор + проверяющая) × 2 прохода. Вход, которого ещё нет (тексты разделов
 * для полного, полный для «Очень кратко», проверяемый текст), - сверху выходом этапа, который
 * его напишет; `extra` - токены входа сверх запроса.
 */
function textUsd(
  author: StageCallEstimator,
  review: StageCallEstimator,
  request: ShapedRequest,
  reviewRequest: ShapedRequest,
  extra: number,
): Prisma.Decimal {
  return author
    .estimate(request, extra)
    .add(review.estimate(reviewRequest, extra + author.maxTokens))
    .mul(PASSES);
}

/**
 * Оценка конвейера (`tech.md` §6-§7): каждый раздел плана, полный и «Очень кратко», каждый текст ×
 * 2 прохода автора и проверки, сверху. `extraInputTokens` - сверху на досье и глоссарий, которых
 * ещё нет.
 */
export function pipelineUsd(
  calls: WriteEstimators,
  context: PartContext,
  sources: readonly SectionSource[],
  extraInputTokens: number,
): Prisma.Decimal {
  let usd = new Prisma.Decimal(0);
  for (const source of sources) {
    const part = sectionPart(context, source, null);
    usd = usd.add(
      textUsd(calls.section, calls.review, part.author(null), part.review(''), extraInputTokens),
    );
  }
  const sectionsOut = sources.length * calls.section.maxTokens;
  const full = fullPart(context, [], NO_QUOTES, null);
  usd = usd.add(
    textUsd(
      calls.full,
      calls.review,
      full.author(null),
      full.review(''),
      extraInputTokens + sectionsOut,
    ),
  );
  const brief = briefPart(context, '', NO_QUOTES, null);
  return usd.add(
    textUsd(calls.brief, calls.review, brief.author(null), brief.review(''), calls.full.maxTokens),
  );
}

/** Оценка одного текста перегенерации (`tech.md` §4): × 2 прохода, вход сверху как у конвейера. */
export function partUsd(
  calls: WriteEstimators,
  part: PartInput,
  extraInputTokens: number,
): Prisma.Decimal {
  const author = calls[part.target];
  return textUsd(author, calls.review, part.author(null), part.review(''), extraInputTokens);
}

/** Полный и «Очень кратко» сверху - достройка после первого текста раздела (`tech.md` §4). */
export function tailUsd(
  calls: WriteEstimators,
  context: PartContext,
  sections: number,
): Prisma.Decimal {
  const full = fullPart(context, [], NO_QUOTES, null);
  const brief = briefPart(context, '', NO_QUOTES, null);
  return textUsd(
    calls.full,
    calls.review,
    full.author(null),
    full.review(''),
    sections * calls.section.maxTokens,
  ).add(
    textUsd(calls.brief, calls.review, brief.author(null), brief.review(''), calls.full.maxTokens),
  );
}
