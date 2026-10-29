import { Language } from '@prisma/client';
import { estimateInputTokens, LlmChatMessage, LlmJsonSchema } from '../../llm/openrouter.client';
import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import { FENCE_RULE, fenceAll, fenced } from '../fenced-data';
import {
  DossierListLimits,
  measureSummaryEntry,
  SummaryEntrySize,
  summaryInputChars,
} from './dossier-groups';
import { SUMMARY_CHAPTERS_FENCE, SUMMARY_PARTS_FENCE } from './dossier.constants';
import { DossierPartPlan } from './dossier-parts';
import {
  DOSSIER_MERGE_SHAPE,
  DOSSIER_PART_SHAPE,
  DOSSIER_SHAPE,
  GLOSSARY_SHAPE,
  jsonSchemaOf,
} from './dossier.format';

/**
 * Промпты этапов `dossier` и `glossary` (`F05-2`, шаг 9). Правила плана разделов - этап 1
 * промпта пересказа владельца (`books-app-docs/features/F04-summary-variants/prompts/`).
 * Ответ - JSON по схеме формы (`dossier.format.ts`); текст книги идёт только в сообщения
 * вызова и никуда не пишется.
 */

const FACTS_ONLY =
  'Everything you write is a fact from the text, with reader chapter numbers. No interpretation, ' +
  'no evaluation, no facts from outside the text. Write in the language of the text.';

export function dossierPartMessages(part: DossierPartPlan): LlmChatMessage[] {
  const [title, text] = fenceAll([
    ['TITLE', part.chapterTitle ?? ''],
    ['TEXT', part.text],
  ]);
  return [
    {
      role: 'system',
      content:
        'You read one piece of a book chapter and extract a partial dossier: a reference the ' +
        'translator, the summary writer and the analyst will use. ' +
        FACTS_ONLY +
        '\n- summary: 2-4 sentences, what happens in this piece.' +
        '\n- characters: everyone who appears or is named; name as written, other names and ' +
        'nicknames, gender as the text shows it ("unknown" if it does not), who they are in one ' +
        'line, how they address others (to whom, form: formal/informal/title), relations with labels.' +
        '\n- entities: places, objects, organizations, terms as written and what they are.' +
        '\n- events: key events in story order; orderNote - where the telling order differs.' +
        '\n- voice: pace, sentence length, lexicon, irony as notes; devices with how they show and ' +
        'a short example quoted from the text.' +
        '\n- motifs: recurring images.' +
        '\nBlocks are given as "[n] text"; inline markup is kept. ' +
        FENCE_RULE,
    },
    {
      role: 'user',
      content:
        `Reader chapter ${part.chapterNumber}, piece ${part.partIndex + 1}.\n\n` +
        (part.chapterTitle ? `Chapter title:\n${title.block}\n\n` : '') +
        text.block,
    },
  ];
}

/**
 * Образцы названий разделов пересказа на языках сайта - из этапа 1 промпта владельца
 * (`books-app-docs/features/F04-summary-variants/prompts/book-summary.md`).
 */
const SECTION_TITLE_PATTERNS =
  'en: "Chapter 5", "Chapters 5-6", "Part One"; ' +
  'es: "Capítulo 5", "Capítulos 5-6", "Primera parte"; ' +
  'fr: "Chapitre 5", "Chapitres 5-6", "Première partie"; ' +
  'pt: "Capítulo 5", "Capítulos 5-6", "Primeira parte"; ' +
  'ru: "Глава 5", "Главы 5-6", "Часть первая"';

/**
 * Правила списков глав и разделов: их пишет только сводка, которая видит главы (`F05-12`).
 * `maxSections` - доля группы в потолке разделов пересказа (`SUMMARY_SECTION_LIMITS`), чтобы
 * склейка планов групп его не превысила.
 */
const chapterListRules = (maxSections: number): string =>
  '\n- chapters: every reader chapter: number, title as in the text (empty if none), 1-2 ' +
  'line summary.' +
  '\n- summaryPlan: sections of the retelling. A section is a complete piece of the plot a ' +
  'reader looks for separately: one chapter, a part of the book, or 2-3 short chapters of ' +
  'one line; no break inside a section that deserves its own page. Very short chapters ' +
  '(under ~1500 words) of one scene may join a neighbour - say so in "why". Title in the ' +
  'language of the text: "<Chapter> 5. <title>" if the chapter has a title, "<Chapter> 5" ' +
  'if not, "<Chapters> 5-6", "<Part One>". Patterns by language - ' +
  SECTION_TITLE_PATTERNS +
  '; for another language use its own words. Never the words "summary" or "retelling" or ' +
  `the book title. At most ${maxSections} sections; number them from 1.`;

/** Начало системного сообщения сводки: по нему заглушка OpenRouter в e2e узнаёт вызов без `response_format`. */
export const DOSSIER_SUMMARY_PROMPT_START =
  'You merge partial dossiers into one dossier of the part of the book they cover:';

export function dossierSummaryMessages(input: {
  chapters: Array<{ number: number; title: string }>;
  /** Частичные досье кусков или результаты групп прошлого уровня (`F05-Rb`). */
  parts: object[];
  /**
   * Сводка выше уровня 0 или итог по группам (`F05-12`): `chapters` и `summaryPlan` склеивает код,
   * модель их не пишет.
   */
  merge?: boolean;
  /** Потолки списков от `maxTokens` этапа (`dossierListLimits`, `F05-12`). */
  limits: DossierListLimits;
  /** Потолок разделов плана этого вызова; без него - весь потолок пересказа. */
  maxSections?: number;
}): LlmChatMessage[] {
  const listRules = input.merge
    ? '\n- chapters and summaryPlan are assembled separately from the groups: do not write them.'
    : chapterListRules(input.maxSections ?? SUMMARY_SECTION_LIMITS.sectionsPerVersion);
  // Имена обеих оград зависят от обоих текстов - так же их считает `summaryInputChars`.
  const [chapters, parts] = fenceAll([
    [SUMMARY_CHAPTERS_FENCE, JSON.stringify(input.chapters)],
    [SUMMARY_PARTS_FENCE, JSON.stringify(input.parts)],
  ]);
  return [
    {
      role: 'system',
      content:
        DOSSIER_SUMMARY_PROMPT_START +
        ' partial dossiers of chapter pieces or dossiers of groups of chapters, in book order. ' +
        FACTS_ONLY +
        '\n- characters: one entry per person (merge variants of the name), stable key in ' +
        'lower-case latin (e.g. "elizabeth-bennet"), firstChapter, fate at the end in one line, ' +
        `role main/secondary/episodic. Main first. At most ${input.limits.characters} ` +
        'characters: when there are more, keep the main and secondary ones and drop episodic ' +
        'ones first.' +
        '\n- entities: one per place/object/organization/term with key and firstChapter; at most ' +
        `${input.limits.entities}, the ones that recur first.` +
        '\n- narration: who narrates, person, form (letters, diaries, framed stories) and notes.' +
        '\n- setting: place and time of action.' +
        '\n- structure: parts of the book with their chapters, as the author divides it.' +
        '\n- chronology: key events in story order with chapter; orderNote where the telling ' +
        `order differs from the order of events; at most ${input.limits.chronology} events.` +
        listRules +
        '\n- voice: pace, sentence length, lexicon, irony; devices with how they show, an example ' +
        'quoted from the text and its chapter.' +
        '\n- motifs: recurring images with the chapters where they appear.' +
        '\n' +
        FENCE_RULE,
    },
    {
      role: 'user',
      content: `Chapters:\n${chapters.block}\n\nPartial dossiers:\n${parts.block}`,
    },
  ];
}

export function glossaryMessages(input: {
  dossier: unknown;
  language: Language;
}): LlmChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You build the translation glossary of a book into ${LANGUAGE_NAMES[input.language]} ` +
        `(language code "${input.language}") ` +
        'from its dossier. One entry per character, place, object, organization and term of the ' +
        'dossier: key as in the dossier, source spelling, target spelling, kind, keepOriginal ' +
        '(true when the name stays as written), note (why, transliteration rule). address: how ' +
        'each character addresses others in the target language (from, to, form). phrases: ' +
        'recurring phrases and forms of address with fixed translations. Established ' +
        'translations of the names come first; do not invent meanings. ' +
        FENCE_RULE,
    },
    { role: 'user', content: `Dossier:\n${fenced('DOSSIER', JSON.stringify(input.dossier))}` },
  ];
}

/** Полное название языка цели: код `pt` рядом с `es` модель путает (`product.md` §3 п.1). */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  ru: 'Russian',
};

/**
 * Замечание к ответу не по форме: модель получает свой прошлый ответ и список ошибок (Р-повтор).
 * Прошлый ответ - текст модели, в который мог попасть текст книги, поэтому он идёт данными в
 * ограде, а не ходом `assistant`; имя ограды свободно во всех сообщениях вызова (`context`).
 */
export function shapeRemark(
  answer: string,
  errors: string[],
  context: readonly string[],
): LlmChatMessage[] {
  // Ошибки цитируют значения ответа (цитата, имя приёма) - тоже данные, в ограде.
  const [errorsBlock, previous] = fenceAll(
    [
      ['FORM_ERRORS', errors.slice(0, 30).join('\n')],
      ['PREVIOUS_ANSWER', answer],
    ],
    context,
  );
  return [
    {
      role: 'user',
      content:
        `Your previous answer is in the ${previous.name} block. It does not match the required ` +
        `JSON form: the ${errorsBlock.name} block lists the wrong places. Fix them and answer ` +
        `with the whole JSON again.\n${errorsBlock.block}\n\n${previous.block}`,
    },
  ];
}

/**
 * Форма ответа - в системном сообщении: `response_format` уходит только моделям со
 * `structured_outputs`, а остальным схему иначе не увидеть. Оценка считает то же сообщение.
 */
export function withAnswerForm(
  messages: LlmChatMessage[],
  schema: Record<string, unknown>,
): LlmChatMessage[] {
  const form = `\n\nAnswer with JSON only, matching this JSON Schema:\n${JSON.stringify(schema)}`;
  return messages.map((m, i) => (i === 0 ? { ...m, content: m.content + form } : m));
}

/**
 * Сообщения с формой ответа и схема для `response_format` - одним целым на вызов и оценку.
 * `textOnly` - схема только в тексте (`LlmJsonSchema.textOnly`).
 */
export function shapedRequest(
  name: string,
  shape: Parameters<typeof jsonSchemaOf>[0],
  messages: LlmChatMessage[],
  options: { textOnly?: boolean } = {},
): { messages: LlmChatMessage[]; jsonSchema: LlmJsonSchema } {
  const schema = jsonSchemaOf(shape);
  const jsonSchema: LlmJsonSchema = options.textOnly
    ? { name, schema, textOnly: true }
    : { name, schema };
  return { messages: withAnswerForm(messages, schema), jsonSchema };
}

export type ShapedRequest = ReturnType<typeof shapedRequest>;

export const dossierPartRequest = (part: DossierPartPlan) =>
  shapedRequest('dossier_part', DOSSIER_PART_SHAPE, dossierPartMessages(part));

/** Схема сводки - только в тексте: Claude не компилирует её грамматику (Р1 `F05 | F05-R`). */
export const dossierSummaryRequest = (input: Parameters<typeof dossierSummaryMessages>[0]) =>
  shapedRequest(
    'dossier',
    input.merge ? DOSSIER_MERGE_SHAPE : DOSSIER_SHAPE,
    dossierSummaryMessages(input),
    { textOnly: true },
  );

/**
 * Вход уровня выше нулевого без ответов групп: названия всех глав и потолки списков. Одна мерка
 * на проверку обработчика перед записью уровня 0 и на отказ на старте (`F05-13b`).
 */
export const emptyMergeInputChars = (
  chapters: Parameters<typeof dossierSummaryMessages>[0]['chapters'],
  limits: DossierListLimits,
) => estimateInputTokens(dossierSummaryRequest({ chapters, parts: [], merge: true, limits }));

/**
 * Мерка входа сводки для упаковки групп: пустой запрос и мерка названий глав - из одного входа,
 * того же, что уйдёт в `dossierSummaryRequest`; проба - сложение по меркам элементов (Р6
 * `F05 | F05-Rb`, T146).
 */
export function summaryInputEstimator(
  input: Omit<Parameters<typeof dossierSummaryMessages>[0], 'parts'>,
): (entries: readonly SummaryEntrySize[]) => number {
  const emptyChars = estimateInputTokens(dossierSummaryRequest({ ...input, parts: [] }));
  const chapters = measureSummaryEntry(input.chapters);
  return (entries) => summaryInputChars(emptyChars, entries, chapters);
}

export const glossaryRequest = (input: Parameters<typeof glossaryMessages>[0]) =>
  shapedRequest('glossary', GLOSSARY_SHAPE, glossaryMessages(input));
