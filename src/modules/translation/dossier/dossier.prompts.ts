import { Language } from '@prisma/client';
import { LlmChatMessage, LlmJsonSchema } from '../../llm/openrouter.client';
import { DossierPartPlan } from './dossier-parts';
import { DOSSIER_PART_SHAPE, DOSSIER_SHAPE, GLOSSARY_SHAPE, jsonSchemaOf } from './dossier.format';

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
        '\nBlocks are given as "[n] text"; inline markup is kept.',
    },
    {
      role: 'user',
      content:
        `Reader chapter ${part.chapterNumber}` +
        (part.chapterTitle ? ` "${part.chapterTitle}"` : '') +
        `, piece ${part.partIndex + 1}.\n\n${part.text}`,
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

export function dossierSummaryMessages(input: {
  chapters: Array<{ number: number; title: string }>;
  parts: Array<{ chapterNumber: number; partIndex: number; data: unknown }>;
}): LlmChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You merge partial dossiers of every chapter piece into one book dossier. ' +
        FACTS_ONLY +
        '\n- characters: one entry per person (merge variants of the name), stable key in ' +
        'lower-case latin (e.g. "elizabeth-bennet"), firstChapter, fate at the end in one line, ' +
        'role main/secondary/episodic. Main first.' +
        '\n- entities: one per place/object/organization/term with key and firstChapter.' +
        '\n- narration: who narrates, person, form (letters, diaries, framed stories) and notes.' +
        '\n- setting: place and time of action.' +
        '\n- structure: parts of the book with their chapters, as the author divides it.' +
        '\n- chronology: key events in story order with chapter; orderNote where the telling ' +
        'order differs from the order of events.' +
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
        'the book title. At most 200 sections; number them from 1.' +
        '\n- voice: pace, sentence length, lexicon, irony; devices with how they show, an example ' +
        'quoted from the text and its chapter.' +
        '\n- motifs: recurring images with the chapters where they appear.',
    },
    {
      role: 'user',
      content:
        `Chapters: ${JSON.stringify(input.chapters)}\n\n` +
        `Partial dossiers: ${JSON.stringify(input.parts)}`,
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
        'translations of the names come first; do not invent meanings.',
    },
    { role: 'user', content: `Dossier: ${JSON.stringify(input.dossier)}` },
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

/** Замечание к ответу не по форме: модель получает свой ответ и список ошибок (Р-повтор). */
export function shapeRemark(answer: string, errors: string[]): LlmChatMessage[] {
  return [
    { role: 'assistant', content: answer },
    {
      role: 'user',
      content:
        'The answer does not match the required JSON form. Fix these places and answer with the ' +
        `whole JSON again:\n${errors.slice(0, 30).join('\n')}`,
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
  shapedRequest('dossier', DOSSIER_SHAPE, dossierSummaryMessages(input), { textOnly: true });

export const glossaryRequest = (input: Parameters<typeof glossaryMessages>[0]) =>
  shapedRequest('glossary', GLOSSARY_SHAPE, glossaryMessages(input));
