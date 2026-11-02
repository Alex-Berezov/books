import { Language } from '@prisma/client';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { Shape } from '../dossier/dossier.format';
import { LANGUAGE_NAMES, shapedRequest, ShapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenceAll, remarksPart } from '../fenced-data';
import { DraftRemark } from '../draft-quality/text-checks';
import { Redo, REVIEW_SHAPE } from '../draft-quality/quality-loop';
import {
  BRIEF_PARAGRAPHS,
  FIRST_SENTENCE_MAX_CHARS,
  QUOTES_MAX,
  FLAT_FULL_MAX_SECTIONS,
  FULL_SUBHEADINGS,
  lengthBounds,
  SummaryTarget,
} from './summary-checks';
import {
  SUMMARY_BRIEF_WRITE_STAGE,
  SUMMARY_FULL_WRITE_STAGE,
  SUMMARY_REVIEW_STAGE,
  SUMMARY_SECTION_WRITE_STAGE,
} from './summary-write.constants';

/**
 * Промпты чистовика пересказа (`F06`; `features/F06-summary-autofill/product.md` §2, `tech.md` §3):
 * требования §2 перенесены по смыслу - объёмы, строй, первое предложение, запреты. Текст для
 * публикации на сайте, не черновик (D2). Текст книги, досье, глоссарий, прошлый ответ и замечания -
 * данные в оградах (`F05-14`), а не инструкция. Название раздела модель не пишет - его ставит код
 * (`sectionTitle`, §2.1).
 */

const str = 'string' as const;

/** Ответ автора раздела, полного и «Очень кратко». */
export const SUMMARY_WRITE_SHAPE: Shape = { object: { text: str } };

/** Правила §2, общие для трёх частей. */
function commonRules(language: Language): string {
  const name = LANGUAGE_NAMES[language];
  return [
    'This is the text for publication on the site, not a draft: write it finished, at the level of ' +
      'a good editor.',
    'Only what is in the text of the book: no history of writing, no criticism, no adaptations, ' +
      'no biography, no dates the text does not give. No interpretation and no evaluation ' +
      '("a brilliant scene", "the author wants to say").',
    `Write in ${name} (language code "${language}") at the level of a native speaker: living ` +
      'literary language, no calques from the language of the original, no mixing of languages. ' +
      'Names of characters, places and objects exactly as in the glossary.',
    'Retell in your own words. A quotation only word for word from the given text, inside ' +
      'quotation marks.',
    'Present tense of narration, third person, the neutral tone of the editors. No addresses to ' +
      'the reader, no "in this chapter we will learn", no spoiler warnings: the retelling reveals ' +
      'the ending.',
    'No service phrases ("Sure, here is the summary"), no notes, no Markdown unless the rules ' +
      'below ask for "## " subheadings. Paragraphs are separated by an empty line.',
  ]
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');
}

/** Предел цитат автору (§2) - из той же константы, что и у проверяющей. */
const quotesRule = (max: number | null): string =>
  max === null ? '' : `At most ${max} quotation${max === 1 ? '' : 's'}.`;

const range = (target: SummaryTarget, source: number) => {
  const { min, max } = lengthBounds(target, source);
  return `from ${min} to ${max} words`;
};

/** Переделка (U5): прошлый текст и замечания - данными; сообщение одно на все части. */
export type RedoInput = Redo<string>;

const remarksText = (remarks: readonly DraftRemark[]): string =>
  remarks.map((r) => `- ${r.code} (${r.where}): ${r.note}`).join('\n');

function messages(
  system: string,
  items: Array<readonly [string, string]>,
  lead: (names: string[]) => string,
  redo: RedoInput | null,
): LlmChatMessage[] {
  const all = redo
    ? [
        ...items,
        ['PREVIOUS_TEXT', redo.previous] as const,
        ['REMARKS', remarksText(redo.remarks)] as const,
      ]
    : items;
  const fences = fenceAll(all);
  const names = fences.map((f) => f.name);
  const body = fences.slice(0, items.length).map((f) => f.block);
  // Замечания - найденные дефекты, а не указания: одна подача на все промпты повтора (`F05-14`).
  const [previous, remarks] = fences.slice(items.length);
  const redoText = redo
    ? `\n\n${previous.block}\n\n` +
      remarksPart(
        `Your previous text is in the ${previous.name} block;`,
        'rewrite the text so that every defect is fixed; keep what is right.',
        remarks,
      )
    : '';
  return [
    { role: 'system', content: `${system}\n\n${FENCE_RULE}` },
    { role: 'user', content: `${lead(names)}\n\n${body.join('\n\n')}${redoText}` },
  ];
}

export interface SectionWriteInput {
  language: Language;
  /** План раздела из досье. */
  plan: string;
  /** Краткое содержание глав раздела из досье. */
  chapterSummaries: string;
  glossary: string;
  /** Текст глав раздела этой версии. */
  chaptersText: string;
  /** Слов в тексте глав раздела - для границ объёма. */
  chaptersWords: number;
  redo: RedoInput | null;
  /** Замечание редактора к «Regenerate» (`F06-3`); нет - `null`. */
  editorNote: string | null;
}

export function sectionWriteRequest(input: SectionWriteInput): ShapedRequest {
  const system =
    'You write one section of the retelling of a book for its page on the site. A reader often ' +
    'comes to this page from search and has not seen the neighbouring sections.\n' +
    commonRules(input.language) +
    '\nRules of the section:' +
    `\n- Length: ${range('section', input.chaptersWords)}. Do not pad.` +
    `\n- The first sentence: the main event of this section with the name of the hero, at most ` +
    `${FIRST_SENTENCE_MAX_CHARS} characters (it is the page description).` +
    '\n- Order: what has happened by the start of the section (one sentence), then the events in ' +
    'order, then how the section ends. The ending of the section is required.' +
    '\n- Every key event of the section from the chapter summaries of the dossier.' +
    '\n- The section reads on its own: name each character in full at the first mention.' +
    `\n- ${quotesRule(QUOTES_MAX.section)}` +
    '\n- No headings inside.' +
    '\ntext: the section only, without a title.';
  const items: Array<readonly [string, string]> = [
    ['PLAN', input.plan],
    ['CHAPTER_SUMMARIES', input.chapterSummaries],
    ['GLOSSARY', input.glossary],
    ['CHAPTERS', input.chaptersText],
  ];
  return shapedRequest(
    SUMMARY_SECTION_WRITE_STAGE,
    SUMMARY_WRITE_SHAPE,
    messages(
      system,
      withEditorNote(items, input.editorNote),
      (n) =>
        `The section plan is in ${n[0]}, the chapter summaries in ${n[1]}, the glossary in ${n[2]} ` +
        `and the text of the chapters in ${n[3]}.` +
        editorNoteLead(n, items.length, input.editorNote),
      input.redo,
    ),
  );
}

/** Замечание редактора к «Regenerate» (`product.md` §5) - последним блоком данных, если есть. */
function withEditorNote(
  items: Array<readonly [string, string]>,
  note: string | null,
): Array<readonly [string, string]> {
  return note === null ? items : [...items, ['EDITOR_NOTE', note]];
}

const editorNoteLead = (names: string[], at: number, note: string | null): string =>
  note === null ? '' : ` The editor asks for this in ${names[at]}.`;

export interface FullWriteInput {
  language: Language;
  /** Герои и хронология из досье. */
  dossier: string;
  glossary: string;
  sections: ReadonlyArray<{ title: string; text: string }>;
  /** Слов во всех разделах - для границ объёма. */
  sectionsWords: number;
  redo: RedoInput | null;
  /** Замечание редактора к «Regenerate» (`product.md` §5); нет - `null`. */
  editorNote: string | null;
}

export function fullWriteRequest(input: FullWriteInput): ShapedRequest {
  const flat = input.sections.length <= FLAT_FULL_MAX_SECTIONS;
  const system =
    'You write the full retelling of a book for its summary page on the site from the checked ' +
    'section retellings and the dossier.\n' +
    commonRules(input.language) +
    '\nRules of the full retelling:' +
    `\n- Length: ${range('full', input.sectionsWords)}.` +
    `\n- The first sentence at most ${FIRST_SENTENCE_MAX_CHARS} characters.` +
    (flat
      ? '\n- An introductory paragraph (what the book is about, who the main hero is, where and ' +
        'when), then the plot in order, then the ending. No subheadings.'
      : '\n- An introductory paragraph (what the book is about, who the main hero is, where and ' +
        `when), then from ${FULL_SUBHEADINGS.min} to ${FULL_SUBHEADINGS.max} "## " subheadings ` +
        'along the plot, then the ending.') +
    '\n- The whole plot with the outcome; every section is reflected; not one fact beyond the ' +
    'sections.' +
    '\n- Do not repeat the sections word for word: say it in other words.' +
    `\n- ${quotesRule(QUOTES_MAX.full)}`;
  const items: Array<readonly [string, string]> = [
    ['DOSSIER', input.dossier],
    ['GLOSSARY', input.glossary],
    ['SECTIONS', input.sections.map((s) => `${s.title}\n\n${s.text}`).join('\n\n---\n\n')],
  ];
  return shapedRequest(
    SUMMARY_FULL_WRITE_STAGE,
    SUMMARY_WRITE_SHAPE,
    messages(
      system,
      withEditorNote(items, input.editorNote),
      (n) =>
        `The dossier is in ${n[0]}, the glossary in ${n[1]} and the sections in ${n[2]}.` +
        editorNoteLead(n, items.length, input.editorNote),
      input.redo,
    ),
  );
}

export interface BriefWriteInput {
  language: Language;
  glossary: string;
  full: string;
  /** Слов в полном - для границ объёма. */
  fullWords: number;
  redo: RedoInput | null;
  /** Замечание редактора к «Regenerate» (`product.md` §5); нет - `null`. */
  editorNote: string | null;
}

export function briefWriteRequest(input: BriefWriteInput): ShapedRequest {
  const system =
    'You write the very short retelling of a book: the block at the top of its summary page on ' +
    'the site, from the checked full retelling.\n' +
    commonRules(input.language) +
    '\nRules of the very short retelling:' +
    `\n- Length: ${range('brief', input.fullWords)}, in ${BRIEF_PARAGRAPHS.min}-${BRIEF_PARAGRAPHS.max} ` +
    `paragraphs (at least ${BRIEF_PARAGRAPHS.shortMin} when the text is under ` +
    `${BRIEF_PARAGRAPHS.shortText} words). No subheadings.` +
    `\n- The first sentence answers "what is the book about", at most ${FIRST_SENTENCE_MAX_CHARS} ` +
    'characters (it is the page description).' +
    '\n- The setup, the main conflict, the climax and the outcome; not one fact beyond the full ' +
    'retelling.' +
    '\n- Do not repeat the full retelling word for word.';
  const items: Array<readonly [string, string]> = [
    ['GLOSSARY', input.glossary],
    ['FULL', input.full],
  ];
  return shapedRequest(
    SUMMARY_BRIEF_WRITE_STAGE,
    SUMMARY_WRITE_SHAPE,
    messages(
      system,
      withEditorNote(items, input.editorNote),
      (n) =>
        `The glossary is in ${n[0]} and the full retelling in ${n[1]}.` +
        editorNoteLead(n, items.length, input.editorNote),
      input.redo,
    ),
  );
}

/** Что проверяющая сверяет с источником, по части (§3). */
const REVIEW_SOURCE: Record<SummaryTarget, string> = {
  section: 'the text of the chapters of the section',
  full: 'the section retellings',
  brief: 'the full retelling',
};

/** Требования своей части (§2.1-§2.3), по которым проверяющая ставит `EVENT_MISSING` и `ORDER_BROKEN`. */
const REVIEW_PART_RULES: Record<SummaryTarget, string> = {
  section:
    'The section must have every key event of the section from the chapter summaries (the ' +
    'context) in order and its ending; each character named in full at the first mention.',
  full:
    'The full retelling must have the whole plot with the outcome and reflect every section; ' +
    'the introductory paragraph (what the book is about, the main hero, where and when) may use ' +
    'the dossier (the context); not one fact beyond the sections and the dossier.',
  brief:
    'The very short retelling must have the setup, the main conflict, the climax and the outcome; ' +
    'not one fact beyond the full retelling.',
};

export interface ReviewInput {
  target: SummaryTarget;
  language: Language;
  source: string;
  /** Что ещё вправе использовать автор: раздел - краткое содержание глав досье, полный - досье. */
  context: string;
  glossary: string;
  text: string;
}

export function summaryReviewRequest(input: ReviewInput): ShapedRequest {
  const quotes = QUOTES_MAX[input.target];
  const system =
    'You check a retelling of a book written for publication on the site. Compare it with its ' +
    `source (${REVIEW_SOURCE[input.target]}) and the glossary, and list what is wrong. The rules ` +
    'the retelling must follow:\n' +
    commonRules(input.language) +
    `\n${REVIEW_PART_RULES[input.target]}` +
    '\nRemark codes:' +
    '\n- NAME_MISMATCH: a name or a place differs from the glossary.' +
    '\n- FACT_UNSUPPORTED: a statement neither the source nor the context has.' +
    '\n- EVENT_MISSING: a key event or the ending is left out.' +
    '\n- EXTERNAL_FACT: facts from outside the text: history of writing, criticism, biography, ' +
    'evaluation.' +
    '\n- ORDER_BROKEN: events are moved so that the meaning changes.' +
    '\n- STYLE_POOR: calques, officialese, repetitions, lifeless language, addresses to the reader' +
    (quotes === null ? '.' : `, more than ${quotes} quotation${quotes === 1 ? '' : 's'}.`) +
    '\nLength, structure, language, whether quotations are word for word and service phrases ' +
    'are checked by code: do not remark on them. where: a short fragment of the retelling; note: ' +
    'what to fix, in English. verdict "ok" with an empty list when there is nothing to fix.';
  return shapedRequest(
    SUMMARY_REVIEW_STAGE,
    REVIEW_SHAPE,
    messages(
      system,
      [
        ['SOURCE', input.source],
        ['CONTEXT', input.context],
        ['GLOSSARY', input.glossary],
        ['RETELLING', input.text],
      ],
      (n) =>
        `The source is in ${n[0]}, the context in ${n[1]}, the glossary in ${n[2]} and the ` +
        `retelling in ${n[3]}.`,
      null,
    ),
  );
}
