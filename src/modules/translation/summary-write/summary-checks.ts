import { Language } from '@prisma/client';
import { sentencesOf } from '../check/language-detector';
import { paragraphsOf } from '../draft-quality/quote-check';
import {
  blocksOf,
  codeRemark,
  DraftRemark,
  isSubheading,
  wordCount,
} from '../draft-quality/text-checks';

/**
 * Код-проверки пересказа, свои у `F06`: объём (`LENGTH_OUT`) и строй (`STRUCTURE_BROKEN`)
 * по `features/F06-summary-autofill/product.md` §2, §3, плюс название раздела - функция
 * от названий глав версии (§2.1), без модели.
 */

/** Границы объёма, слова (`product.md` §2). Границы включительные. */
const SUMMARY_LENGTH = {
  /** §2.1: раздел. */
  section: { min: 250, max: 700 },
  /** §2.1: текст глав раздела короче - раздел от трети до всей длины этого текста. */
  shortSectionSource: 750,
  shortSectionMinShare: 1 / 3,
  /** §2.2: полный - низ `min(2300, 0,6 × разделы)`, верх `min(4600, разделы)`. */
  full: { min: 2300, max: 4600, minShareOfSections: 0.6 },
  /** §2.3: «Очень кратко» при полном от 2400 слов; короче - от четверти до половины полного. */
  brief: { min: 600, max: 1200, fullFrom: 2400, minShare: 1 / 4, maxShare: 1 / 2 },
} as const;

/** §2.3: абзацев «Очень кратко»; у текста короче `shortText` слов - от `shortMin`. */
export const BRIEF_PARAGRAPHS = { min: 5, max: 10, shortText: 600, shortMin: 3 } as const;

/** Цитат не больше (§2): одна на раздел, три в полном; у «Очень кратко» лимита в §2 нет. */
export const QUOTES_MAX: Record<SummaryTarget, number | null> = {
  section: 1,
  full: 3,
  brief: null,
};

/** Первое предложение - не длиннее, знаков: оно идёт в description страницы (§2.1, §2.3, §3). */
export const FIRST_SENTENCE_MAX_CHARS = 160;
/** Подзаголовков `##` у полного (§2.2); у книги из `FLAT_FULL_MAX_SECTIONS` разделов и меньше - ни одного. */
export const FULL_SUBHEADINGS = { min: 4, max: 10 } as const;
export const FLAT_FULL_MAX_SECTIONS = 3;

export type SummaryTarget = 'section' | 'full' | 'brief';

/** Границы объёма части в словах: `source` - слова источника (текст глав раздела, разделы, полный). */
export function lengthBounds(target: SummaryTarget, source: number): { min: number; max: number } {
  const { section, shortSectionSource, shortSectionMinShare, full, brief } = SUMMARY_LENGTH;
  if (target === 'section') {
    return source < shortSectionSource
      ? { min: Math.ceil(source * shortSectionMinShare), max: source }
      : { ...section };
  }
  if (target === 'full') {
    return {
      min: Math.min(full.min, Math.ceil(source * full.minShareOfSections)),
      max: Math.min(full.max, source),
    };
  }
  return source >= brief.fullFrom
    ? { min: brief.min, max: brief.max }
    : { min: Math.ceil(source * brief.minShare), max: Math.floor(source * brief.maxShare) };
}

/** `LENGTH_OUT` (§2, §3): объём вне границ; у «Очень кратко» - и число абзацев (§2.3). */
export function checkLength(target: SummaryTarget, text: string, source: number): DraftRemark[] {
  const words = wordCount(text);
  const { min, max } = lengthBounds(target, source);
  const remarks: DraftRemark[] = [];
  // Пустой текст - всегда вне границ: у главы без слов границы `0..0`, и пустой ответ прошёл бы.
  if (words === 0 || words < min || words > max) {
    remarks.push(
      codeRemark(
        'LENGTH_OUT',
        `${words} words`,
        `The text has ${words} words; it must have from ${min} to ${max}.`,
      ),
    );
  }
  if (target === 'brief') {
    const paragraphLimits = BRIEF_PARAGRAPHS;
    const least =
      words < paragraphLimits.shortText ? paragraphLimits.shortMin : paragraphLimits.min;
    const most = paragraphLimits.max;
    const count = paragraphsOf(text).length;
    if (count < least || count > most) {
      remarks.push(
        codeRemark(
          'LENGTH_OUT',
          `${count} paragraphs`,
          `The text has ${count} paragraphs; it must have from ${least} to ${most}.`,
        ),
      );
    }
  }
  return remarks;
}

/** Часть для проверки строя: полному нужно число разделов плана - без него строй не проверить. */
export type StructurePart = { target: 'section' | 'brief' } | { target: 'full'; sections: number };

/**
 * `STRUCTURE_BROKEN` (§3): первое предложение длиннее `FIRST_SENTENCE_MAX_CHARS`; у полного нет
 * вводного абзаца или подзаголовков не `FULL_SUBHEADINGS` (у книги из 1-3 разделов их быть
 * не должно); у «Очень кратко» есть подзаголовки.
 */
export function checkStructure(part: StructurePart, text: string): DraftRemark[] {
  const remarks: DraftRemark[] = [];
  const paragraphs = blocksOf(text);
  const opening = paragraphs.find((p) => !isSubheading(p)) ?? '';
  const first = sentencesOf(opening)[0] ?? '';
  if (first.length > FIRST_SENTENCE_MAX_CHARS) {
    remarks.push(
      codeRemark(
        'STRUCTURE_BROKEN',
        first,
        `The first sentence has ${first.length} characters; keep it within ${FIRST_SENTENCE_MAX_CHARS}.`,
      ),
    );
  }
  const subheadings = paragraphs.filter(isSubheading).length;
  if (part.target === 'full') {
    if (paragraphs.length > 0 && isSubheading(paragraphs[0])) {
      remarks.push(
        codeRemark(
          'STRUCTURE_BROKEN',
          paragraphs[0],
          'Open with an introductory paragraph before the first subheading.',
        ),
      );
    }
    const flat = part.sections <= FLAT_FULL_MAX_SECTIONS;
    const ok = flat
      ? subheadings === 0
      : subheadings >= FULL_SUBHEADINGS.min && subheadings <= FULL_SUBHEADINGS.max;
    if (!ok) {
      remarks.push(
        codeRemark(
          'STRUCTURE_BROKEN',
          `${subheadings} subheadings`,
          flat
            ? 'This book is short: write the full summary without subheadings.'
            : `Use from ${FULL_SUBHEADINGS.min} to ${FULL_SUBHEADINGS.max} "## " subheadings; there are ${subheadings}.`,
        ),
      );
    }
  } else if (subheadings > 0) {
    remarks.push(
      codeRemark('STRUCTURE_BROKEN', `${subheadings} subheadings`, 'Write it without subheadings.'),
    );
  }
  return remarks;
}

/** Глава без названия и диапазон без названий по форме языка версии (§2.1). */
const CHAPTER_WORD: Record<Language, { one: string; many: string }> = {
  ru: { one: 'Глава', many: 'Главы' },
  en: { one: 'Chapter', many: 'Chapters' },
  es: { one: 'Capítulo', many: 'Capítulos' },
  fr: { one: 'Chapitre', many: 'Chapitres' },
  pt: { one: 'Capítulo', many: 'Capítulos' },
};

/**
 * Название раздела (§2.1) кодом, как в читалке: из одной главы - её название; из нескольких -
 * «первая – последняя». Глава без названия - «Глава N» по языку версии; обе крайние без
 * названий - «Главы N–M».
 */
export function sectionTitle(
  chapters: ReadonlyArray<{ number: number; title: string }>,
  language: Language,
): string {
  const sorted = [...chapters].sort((a, b) => a.number - b.number);
  if (sorted.length === 0) return '';
  const word = CHAPTER_WORD[language];
  const label = (c: { number: number; title: string }) =>
    c.title.trim() !== '' ? c.title.trim() : `${word.one} ${c.number}`;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first.number === last.number) return label(first);
  if (first.title.trim() === '' && last.title.trim() === '') {
    return `${word.many} ${first.number}–${last.number}`;
  }
  return `${label(first)} – ${label(last)}`;
}
