import { Language } from '@prisma/client';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { Shape } from '../dossier/dossier.format';
import { LANGUAGE_NAMES, shapedRequest, ShapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenceAll, remarksPart } from '../fenced-data';
import { Redo, reviewShapeOf } from '../draft-quality/quality-loop';
import { DraftRemark, DraftRemarkCode } from '../draft-quality/text-checks';
import {
  WORLD_EXTERNAL_WRITE_STAGE,
  WORLD_PAGE_WRITE_STAGE,
  WORLD_PAIR_WRITE_STAGE,
  WORLD_REVIEW_STAGE,
  WORLD_SELECT_STAGE,
} from './world-write.constants';
import type { WorldBlock, WorldRunObjectType, WorldWrittenStepKind } from './world-write.data';

/**
 * Промпты хода мира (`F08-4a`; канон - промпт владельца `features/F08-book-wiki/prompts/world-character.md`,
 * эталоны - `example-world.<lang>.json` пяти языков): «Главные правила», «Планка качества текста», «Ядро» и
 * поля страницы перенесены по смыслу для своего шага. Отличия от канона: героев выбирает код
 * (герои `main` и `secondary` анализа версии, `F08-4` Q3, `F08-8b`), формы имени - отдельным шагом,
 * внешние блоки - отдельным шагом со ссылками утверждений на источники; ответ - по строгой форме,
 * поэтому «нет значения» - пустая строка, «нет года» - `0`. Текст глав, анализ, досье, глоссарий,
 * прошлый ответ и замечания - данные в оградах (`F05-14`), а не инструкция. Страница пары (`F08-8e`) -
 * по канону `prompts/world-pair.md` и эталону `example-world-pair.<lang>.json`; пары выбирает код
 * (условие заведения, решения арбитра `F08 | F08-8e-1` Q1, Q3), поэтому шаг пишет одну пару.
 */

const str = 'string' as const;
const int = 'int' as const;
const L = BOOK_WORLD_LIMITS;

const SELECT_SHAPE: Shape = {
  object: {
    characters: { array: { object: { key: str, name: str, aliases: { array: str } } } },
    // Формы названий мест (`F08-12b`, решение `F08 | F08-12b` Q1): падежи ru дают присутствие места.
    places: { array: { object: { key: str, name: str, aliases: { array: str } } } },
    // Формы названий предметов и понятий (`F08-13b`): то же правило, что у мест.
    objects: { array: { object: { key: str, name: str, aliases: { array: str } } } },
    terms: { array: { object: { key: str, name: str, aliases: { array: str } } } },
  },
};

const PAGE_SHAPE: Shape = {
  object: {
    name: str,
    short: str,
    profile: { object: { position: str, relationToMain: str } },
    appearance: str,
    character: str,
    arc: {
      object: {
        from: str,
        to: str,
        stages: { array: { object: { title: str, text: str, chapter: int } } },
      },
    },
    scenes: { array: { object: { chapter: int, title: str, text: str } } },
    relations: { array: { object: { to: str, label: str } } },
    quotes: {
      array: { object: { text: str, chapter: int, speakerKey: str, interpretation: str } },
    },
    faq: { array: { object: { question: str, answer: str } } },
    imageBrief: str,
  },
};

const PAIR_SHAPE: Shape = {
  object: {
    name: str,
    short: str,
    compare: {
      array: { object: { feature: str, a: str, chapterA: int, b: str, chapterB: int } },
    },
    bonds: str,
    differences: str,
    conclusion: str,
    quotes: {
      array: {
        object: { text: str, chapter: int, speakerKey: str, aboutKey: str, interpretation: str },
      },
    },
    faq: { array: { object: { question: str, answer: str } } },
  },
};

/** Страница места (`F08-12b`): блоки места, сцены, цитаты, вопросы и ТЗ на иллюстрацию 16:9. */
const PLACE_SHAPE: Shape = {
  object: {
    name: str,
    short: str,
    kind: str,
    location: str,
    significance: str,
    description: str,
    wikidataId: str,
    scenes: { array: { object: { chapter: int, title: str, text: str } } },
    quotes: {
      array: { object: { text: str, chapter: int, speakerKey: str, interpretation: str } },
    },
    faq: { array: { object: { question: str, answer: str } } },
    imageBrief: str,
  },
};

/**
 * Страница предмета (`F08-13b`; поля - решение арбитра `F08 | F08-13` Q1): значение, описание, цитаты,
 * вопросы и связи с героями мира и темами анализа (Q5); ТЗ на иллюстрацию нет (Q4).
 */
const OBJECT_SHAPE: Shape = {
  object: {
    name: str,
    short: str,
    significance: str,
    description: str,
    quotes: {
      array: { object: { text: str, chapter: int, speakerKey: str, interpretation: str } },
    },
    faq: { array: { object: { question: str, answer: str } } },
    characterKeys: { array: str },
    themeKeys: { array: str },
  },
};

/** Страница понятия (`F08-13b`): «Коротко» - определение глоссария, значение и цитаты (Q1). */
const TERM_SHAPE: Shape = {
  object: {
    name: str,
    short: str,
    significance: str,
    quotes: {
      array: { object: { text: str, chapter: int, speakerKey: str, interpretation: str } },
    },
  },
};

const REFS = { array: int } as const;

const EXTERNAL_SHAPE: Shape = {
  object: {
    critique: { object: { text: str, refs: REFS } },
    prototypes: { object: { text: str, refs: REFS } },
    adaptations: {
      array: {
        object: { title: str, year: int, actor: str, differences: str, refs: REFS },
      },
    },
    sources: { array: { object: { title: str, url: str } } },
  },
};

export const WORLD_STEP_SHAPES: Record<WorldWrittenStepKind, Shape> = {
  select: SELECT_SHAPE,
  page: PAGE_SHAPE,
  external: EXTERNAL_SHAPE,
  pair: PAIR_SHAPE,
  place: PLACE_SHAPE,
  object: OBJECT_SHAPE,
  term: TERM_SHAPE,
};

export const WORLD_STEP_STAGES: Record<WorldWrittenStepKind, string> = {
  select: WORLD_SELECT_STAGE,
  page: WORLD_PAGE_WRITE_STAGE,
  external: WORLD_EXTERNAL_WRITE_STAGE,
  pair: WORLD_PAIR_WRITE_STAGE,
  // Место пишется этапом страницы (`F08-12b`): своя форма ответа, модель и настройки - страницы.
  place: WORLD_PAGE_WRITE_STAGE,
  // Предмет и понятие - тоже этапом страницы (`F08-13b`), каждый своей формой ответа.
  object: WORLD_PAGE_WRITE_STAGE,
  term: WORLD_PAGE_WRITE_STAGE,
};

/** Коды проверяющей мира (`product.md` §5): `SHORT_SPOILER` - исход в «Коротко» (Q6). */
export const WORLD_REVIEW_CODES = [
  'NOT_IN_TEXT',
  'GENERIC',
  'CONTRADICTION',
  'RETELLING',
  'SHORT_SPOILER',
  'STYLE_POOR',
  'EXTERNAL_DOUBT',
] as const satisfies readonly DraftRemarkCode[];

export const WORLD_REVIEW_SHAPE: Shape = reviewShapeOf(WORLD_REVIEW_CODES);

const QUOTE_MARKS: Record<Language, string> = {
  ru: '«ёлочки» (guillemets « »)',
  fr: '« guillemets »',
  en: '“curly quotes”',
  es: 'comillas «» or “”',
  pt: 'aspas “”',
};

const numbered = (rules: readonly string[]): string =>
  rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');

/** «Главные правила» канона для страницы героя по тексту версии. */
function pageRules(language: Language): string {
  return numbered([
    'Do not repeat the analysis and the summary: the plot lives on the summary page, the meaning ' +
      'of the book on the analysis page. Here - the character: name a scene only as much as it ' +
      'shows the character. Do not rewrite the analysis description of the character in other ' +
      'words: give what the analysis does not have - scenes, stages, quotations, relations.',
    'Every statement rests on a scene, a line or a detail with its chapter number from the list ' +
      'of chapters of this version. Replace the name of the character and the title of the book - ' +
      'if the text is still true, it says nothing about this character.',
    '"short" - 2-3 sentences without the ending: who this is, who they are to the main ' +
      'character, what they do at the start of the book. No outcome, no turn of the last third: ' +
      'readers who have not finished the book read it. The fate of the character lives in arc.to ' +
      'and in the late stages.',
    'Quotations only word for word from the text of this version given in the data, with the ' +
      'number of the chapter where the words stand. A part of a sentence is allowed, but letter ' +
      'for letter. Not sure - leave the quotation out: a quotation that is not word for word is ' +
      'thrown away. No quotations in quotation marks inside the prose fields: the words of the ' +
      'book live only in "quotes".',
    'Chapters only from the list of chapters of this version, and only chapters where the ' +
      'character is (the list of chapters with the character is given): a scene or a stage in a ' +
      'chapter without the character is a defect. Not sure of the chapter - leave the scene out.',
    'Do not invent: no dates, biography, prototypes, adaptations, critics or links in this step. ' +
      'Present the disputable as an interpretation ("can be read as…").',
    `Write for the reader of ${LANGUAGE_NAMES[language]} (language code "${language}"), not a ` +
      'translation from English. Names as in the glossary and in the known translations. ' +
      'The only exception: imageBrief is a brief for the editors, not a text for the reader - it ' +
      'is always in English, names the book and its author, and its look rests only on appearance ' +
      '(the rules about scenes, quotations and replacing the name or the title do not apply to it).',
    'Plain text: no HTML, no Markdown, no emoji. Paragraphs of a long text are separated by an ' +
      `empty line. Quotation marks of the language: ${QUOTE_MARKS[language]}.`,
    'Do not speak for the site: no "our editors think", no "we have prepared".',
  ]);
}

/** «Главные правила» канона пары (`prompts/world-pair.md`) для страницы пары по тексту версии. */
function pairRules(language: Language): string {
  return numbered([
    'A comparison, not two portraits. Every row of "compare" is one feature of both characters, ' +
      'and the two sides answer the same question. The page of each character already told who ' +
      'they are: here - only what shows when the two stand side by side. Do not retell the ' +
      'character pages, the analysis or the summary.',
    'Every statement rests on a scene with its chapter. Each side of a row has its own chapter ' +
      'from the list of chapters of this version, where that character is (chapterA for the first ' +
      'character of the key, chapterB for the second). Not sure of the chapter of a side - leave ' +
      'the feature out.',
    '"short" - 2-3 sentences without the ending: who the two are to each other and why they are ' +
      'compared. No outcome, no turn of the last third.',
    'Quotations only word for word from the text of this version given in the data, with the ' +
      'number of the chapter where the words stand, and only words of one character of the pair ' +
      'about the other: speakerKey - who speaks, aboutKey - about whom, both keys of this pair and ' +
      'not the same. No such words - no quotes. No quotations in quotation marks inside the prose ' +
      'fields.',
    'Do not invent: no dates, critics, links or sources - a pair has no external blocks. Present ' +
      'the disputable as an interpretation ("can be read as…").',
    `Write for the reader of ${LANGUAGE_NAMES[language]} (language code "${language}"), not a ` +
      'translation from English. Names as in the glossary and in the known translations.',
    'Plain text: no HTML, no Markdown, no emoji. Paragraphs of a long text are separated by an ' +
      `empty line. Quotation marks of the language: ${QUOTE_MARKS[language]}.`,
    'Do not speak for the site: no "our editors think".',
  ]);
}

/** «Главные правила» страницы места (`F08-12b`, `product.md` §7) по тексту версии. */
function placeRules(language: Language): string {
  return numbered([
    'A place of the book, not a retelling: what the place is, where it is, what happens here and ' +
      'what it means for the book. Name a scene only as much as it shows the place. Do not ' +
      'repeat the analysis, the summary or the character pages.',
    'Every statement rests on a scene or a detail with its chapter number from the list of ' +
      'chapters of this version, and only chapters where the place is (the list of chapters with ' +
      'the place is given): a scene in a chapter without the place is a defect. Not sure of the ' +
      'chapter - leave the scene out.',
    '"short" - 2-3 sentences without the ending: what this place is and who lives or comes here. ' +
      'No outcome, no turn of the last third.',
    'kind - "real" for a place that exists outside the book (a city, a street, a square, a ' +
      'river), "fictional" for a place made up by the author (a room, a house, an invented town). ' +
      'wikidataId - only for a real place, the Wikidata item number (Q and digits) you are sure ' +
      'of; not sure, or a fictional place - "". The code checks the number on Wikidata and draws ' +
      'no point without it.',
    'Quotations only word for word from the text of this version given in the data, with the ' +
      'number of the chapter where the words stand - words that describe the place or are said ' +
      'in it. Not sure - leave the quotation out. No quotations in quotation marks inside the ' +
      'prose fields.',
    'Do not invent: no dates, history, sources or links beyond the text of this version. Present ' +
      'the disputable as an interpretation ("can be read as…").',
    `Write for the reader of ${LANGUAGE_NAMES[language]} (language code "${language}"), not a ` +
      'translation from English. Names as in the glossary and in the known translations. ' +
      'The only exception: imageBrief is a brief for the editors, not a text for the reader - it ' +
      'is always in English, names the book and its author, and its look rests only on ' +
      'description (the rules about scenes and quotations do not apply to it).',
    'Plain text: no HTML, no Markdown, no emoji. Paragraphs of a long text are separated by an ' +
      `empty line. Quotation marks of the language: ${QUOTE_MARKS[language]}.`,
    'Do not speak for the site: no "our editors think".',
  ]);
}

const PLACE_FIELDS =
  'The core - without it there is no page: short, kind, significance and at least 2 scenes with ' +
  'their chapters.' +
  `\nname - the name of the place as in the text of this version (at most ${L.name} characters). ` +
  `short - at most ${L.short} characters. kind - "real" or "fictional". location - where the ` +
  `place is, as the text says (a city, a street, a house), at most ${L.location}, or "". ` +
  `significance - what the place means for the book, a thesis with its scenes, at most ` +
  `${L.significance}. description - how the place looks, only what the text says, at most ` +
  `${L.description}. wikidataId - see the rules, or "". scenes - 2-${L.scenes} key scenes in this ` +
  'place (chapter, title, text - 1-2 sentences: what happens here and what it says about the ' +
  `place). quotes - at most ${L.quotes}, each at most ${L.quote} characters; speakerKey - the key ` +
  'of the speaker from KEYS, or "" when the narrator speaks; interpretation - 1-3 sentences: what ' +
  `the line shows about the place. faq - at most ${L.faq} questions as a reader of this language ` +
  'searches for them, the answer direct in its first sentence.' +
  `\nimageBrief - the brief for an image-generation service that makes the picture of the place ` +
  `for the editors of the site, always in English, at most ${L.imageBrief} characters, not for the ` +
  'reader: a wide 16:9 view, at least 1200 px wide; the title of the book and the name of its ' +
  'author in their widely known English form when you are sure of it, otherwise as in the data; ' +
  'the look of the place only from description; the epoch and the setting only from the text of ' +
  'this version and the analysis. No text, lettering or watermarks in the picture; no recognisable ' +
  'faces, no faces of real actors, no stills of film or stage adaptations, no style of a ' +
  'recognisable artist. Empty description - imageBrief "".' +
  '\nA field without reliable data - "" or an empty list.';

const PAIR_FIELDS =
  `The core - without it there is no page: short, at least 4 rows of compare with both sides and ` +
  'their chapters, conclusion.' +
  `\nname - the names of the two characters joined by "and" of the language (at most ${L.name} ` +
  `characters). short - at most ${L.short} characters. compare - 4-${L.compare} features both ` +
  'characters share, from the outer to the main one: position, character, attitude to the main ' +
  'conflict, fate (a fate that is a turn of the last third - the last row); feature - a few words, ' +
  `a and b - one or two sentences with a scene, at most ${L.mediumText} each. bonds - what binds ` +
  'them: likeness and what brings them together in the plot. differences - the main difference ' +
  `that makes the comparison worth it, not a list of trifles. conclusion - what the pair means for ` +
  `the book, two or three sentences, a thesis, not a repeat of the table; bonds, differences and ` +
  `conclusion at most ${L.mediumText} each. quotes - at most ${L.quotes}, each at most ${L.quote} ` +
  'characters; interpretation - 1-3 sentences: what the line shows about the two. faq - at most ' +
  `${L.faq} questions people really ask about the pair ("why…", "what is the difference…"), the ` +
  'answer direct in its first sentence.' +
  '\nA field without reliable data - "" or an empty list.';

const QUALITY_BAR =
  'Every text about the character passes the quality bar: (1) concreteness - a trait is shown ' +
  'by a deed in a scene with its chapter; (2) development, not a label - where the character ' +
  'starts, what they go through, where they arrive; (3) the answer to "why" - what the book ' +
  'would lose without the character; (4) coherence - relations, scenes and quotations speak ' +
  'about one and the same character and do not argue with the analysis of the book. Nowhere: ' +
  'empty praise ("brilliant", "deep", "a vivid image"), school clichés ("the author wanted to ' +
  'say"), the same thought in different fields, retelling instead of characterisation.';

const PAGE_FIELDS =
  'The core - without it there is no page: short, character, arc.from and arc.to, at least 3 ' +
  'quotations and at least 2 scenes with their chapters.' +
  `\nname - the full name as in the text of this version. short - at most ${L.short} characters. ` +
  `profile.position, profile.relationToMain - a phrase each, at most ${L.profileField} characters, ` +
  `or "". appearance - at most ${L.appearance}, only what the text says. character - at most ` +
  `${L.character}, 1-3 paragraphs, each trait with its scene. arc.from, arc.to - who the character ` +
  `is at the start and at the end, at most ${L.arcText} each; arc.stages - at most ${L.stages} ` +
  `turning points (title, text, chapter). scenes - at most ${L.scenes}, the key scenes (chapter, ` +
  `title, text - 1-2 sentences: what the character does and what it says about them). relations - at most ` +
  `${L.relations}, only to keys from the KEYS block, never to the character itself; label - 1-3 ` +
  `words. quotes - at most ${L.quotes}, each at most ${L.quote} characters, said by the character ` +
  'or about them; speakerKey - the key of the speaker from KEYS, or "" when the narrator speaks or ' +
  `the speaker has no key; interpretation - 1-3 sentences: what the line shows. faq - at most ${L.faq} questions ` +
  'as a reader of this language searches for them, the answer direct in its first sentence.' +
  `\nimageBrief - the brief for an image-generation service that makes the portrait of the character ` +
  `for the editors of the site, always in English, at most ${L.imageBrief} characters, not for the reader: ` +
  'a square 1:1 portrait, at least 1200x1200 px; the title of the book and the name of its author ' +
  'in their widely known English form when you are sure of it, otherwise as in the data; the look of ' +
  'the character only from appearance; the epoch and the setting only from the text of this version ' +
  'and the analysis. No text, lettering or watermarks in the picture; no faces of real actors, no ' +
  'stills of film or stage adaptations, no style of a recognisable artist. Empty appearance - ' +
  'imageBrief "".' +
  '\nA field without reliable data - "" or an empty list; a short exact quotation is better than ' +
  'a long one.';

const SELECT_RULES =
  'You list the name forms of the characters given in the CANDIDATES block, as they stand in the ' +
  'text of this version. For every candidate: key - exactly as given; name - the full name as in ' +
  'this version; aliases - every form by which the text names the character: the full name, the ' +
  'surname, diminutives, forms of address, name and patronymic and, for ru, the case forms ' +
  '("Раскольникова", "Соню"); es, fr and pt have no case forms: there the forms are the spellings ' +
  'exactly as this version writes them, accents as in the text, and its diminutives (es "Raskólnikov", "Sónechka"; ' +
  `fr "Raskolnikov", "Sonietchka"; pt "Ródia", "Sônia"); each form separately, at most ${L.aliases}. ` +
  'Only forms that ' +
  'really stand in the text: the code counts the chapters of the character by them and throws ' +
  'away a form that is not in the text. No common words that occur without the character ' +
  '("the old woman", "the student"), no forms shorter than 3 letters. Do not add characters.' +
  '\nThe same for the places given in the PLACE_CANDIDATES block (none - "places" []): key exactly ' +
  'as given; name - the name of the place as in this version; aliases - every form by which the ' +
  'text names the place, for ru with the case forms ("в Петербурге", "Петербурга" - each form ' +
  'without the preposition: "Петербурге"). No common words ("the room", "the street") unless they ' +
  'are the only name of this place. Do not add places.' +
  '\nThe same for the objects in OBJECT_CANDIDATES and the terms in TERM_CANDIDATES (none - ' +
  '"objects" [] or "terms" []): key exactly as given; name - the name as in this version; aliases - ' +
  'every form by which the text names it, for ru with the case forms ("топором", "заклада"). No ' +
  'common words that occur in the text without this object or term. Do not add objects or terms.';

function externalRules(language: Language): string {
  return numbered([
    'You write the external blocks of one character page: critique (the character in criticism), ' +
      'prototypes (the real prototypes), adaptations (the character in film, series and stage). ' +
      'These are facts not from the text of the book.',
    'Every statement only with sources from your "sources" list - full https addresses of pages ' +
      'you are sure exist and name the book or its author. refs - the indexes (from 0) of the ' +
      'sources of the statement. The code opens every source: a statement without an opened ' +
      'source about this book is thrown away.',
    'Not sure of a date, a name, an actor or a fact - leave the statement out: an empty block is ' +
      'not shown, a mistake stays on the page. No block - text "" and refs [], no adaptations - [].',
    `critique - at most ${L.critique} characters; prototypes - at most ${L.prototypes}; ` +
      `adaptations - at most ${L.adaptations} (title, year or 0, actor or "", differences - how ` +
      `the character differs from the book). sources - at most ${L.sources}.`,
    `Write for the reader of ${LANGUAGE_NAMES[language]} (language code "${language}"). Plain ` +
      `text, no Markdown. Quotation marks of the language: ${QUOTE_MARKS[language]}. No ` +
      'quotations of the book and no chapter numbers.',
  ]);
}

/** Образец формы внешнего шага: у эталона внешних блоков нет, адреса - заведомо не настоящие. */
const EXTERNAL_SAMPLE = JSON.stringify({
  critique: {
    text: 'A paragraph on how critics read the character, with the critic named.',
    refs: [0],
  },
  prototypes: { text: '', refs: [] },
  adaptations: [
    {
      title: 'Title of the film',
      year: 1970,
      actor: 'Actor name',
      differences: 'How the screen character differs.',
      refs: [1],
    },
  ],
  sources: [
    { title: 'Title of the article', url: 'https://encyclopedia.example/article-1' },
    { title: 'Title of the film page', url: 'https://films.example/film-1' },
  ],
});

export type WorldRedo = Redo<unknown>;

const remarksText = (remarks: readonly DraftRemark[]): string =>
  remarks.map((r) => `- ${r.code} (${r.where}): ${r.note}`).join('\n');

/** Сообщения автору: данные в оградах, на переделке - прошлый ответ и замечания. */
function messages(
  system: string,
  items: Array<readonly [string, string]>,
  lead: (names: string[]) => string,
  redo: WorldRedo | null,
): LlmChatMessage[] {
  const all = redo
    ? [
        ...items,
        ['PREVIOUS_ANSWER', JSON.stringify(redo.previous)] as const,
        ['REMARKS', remarksText(redo.remarks)] as const,
      ]
    : items;
  const fences = fenceAll(all, []);
  const names = fences.map((f) => f.name);
  const body = fences.slice(0, items.length).map((f) => f.block);
  const [previous, remarks] = fences.slice(items.length);
  const redoText = redo
    ? `\n\n${previous.block}\n\n` +
      remarksPart(
        `Your previous answer is in the ${previous.name} block;`,
        'answer again so that every defect is fixed; keep what is right.',
        remarks,
      )
    : '';
  return [
    { role: 'system', content: `${system}\n\n${FENCE_RULE}` },
    { role: 'user', content: `${lead(names)}\n\n${body.join('\n\n')}${redoText}` },
  ];
}

/** Перегенерация одного блока страницы: прежнее содержимое и замечание редактора. */
export interface WorldRegenSpec {
  block: WorldBlock;
  current: unknown;
  remark: string | null;
}

const regenRule = (regen: WorldRegenSpec): string =>
  `\nThe editor asks to rewrite one block of this page: "${regen.block}". Rewrite only it, take ` +
  'the editor remark into account; the code throws the other blocks of the answer away.';

const regenItems = (regen: WorldRegenSpec | null): Array<readonly [string, string]> =>
  regen
    ? [
        ['CURRENT_BLOCK', JSON.stringify(regen.current ?? null)],
        ['EDITOR_REMARK', regen.remark ?? 'none'],
      ]
    : [];

/** Перечень меток для вступления: «X in BLOCK_1, Y in BLOCK_2». */
const leadOf =
  (labels: readonly string[], tail: string) =>
  (names: string[]): string =>
    `${labels.map((label, i) => `${label} in ${names[i]}`).join(', ')}. ${tail}`;

export interface SelectPromptInput {
  language: Language;
  bookTitle: string;
  author: string;
  candidates: string;
  /** Кандидаты-места (`F08-12b`): «ключ - название» досье, `none` - мест нет. */
  places: string;
  /** Кандидаты-предметы и кандидаты-понятия (`F08-13b`): «ключ - название» досье, `none` - нет. */
  objects: string;
  terms: string;
  dossierNames: string;
  glossary: string;
  book: string;
  redo: WorldRedo | null;
}

export function selectWriteRequest(input: SelectPromptInput): ShapedRequest {
  const system =
    'You prepare the character pages of a book for the site. ' +
    SELECT_RULES +
    `\nWrite the names in ${LANGUAGE_NAMES[input.language]} as in the text of this version.`;
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['CANDIDATES', input.candidates],
    ['PLACE_CANDIDATES', input.places],
    ['OBJECT_CANDIDATES', input.objects],
    ['TERM_CANDIDATES', input.terms],
    ['DOSSIER_NAMES', input.dossierNames],
    ['GLOSSARY', input.glossary],
    ['BOOK_TEXT', input.book],
  ];
  return shapedRequest(
    WORLD_SELECT_STAGE,
    SELECT_SHAPE,
    messages(
      system,
      items,
      leadOf(
        [
          'The title of the book is',
          'the author',
          'the candidates (key - name in the analysis)',
          'the place candidates (key - name in the dossier)',
          'the object candidates (key - name in the dossier)',
          'the term candidates (key - name in the dossier)',
          'the names and variants of the dossier',
          'the glossary',
          'the text of this version',
        ],
        'List the name forms of every candidate, every place, object and term candidate.',
      ),
      input.redo,
    ),
  );
}

export interface PagePromptInput {
  language: Language;
  bookTitle: string;
  author: string;
  key: string;
  name: string;
  aliases: string;
  chapterList: string;
  mentionChapters: string;
  keys: string;
  analysis: string;
  glossary: string;
  example: string;
  book: string;
  bookIsPartial: boolean;
  regen: WorldRegenSpec | null;
  redo: WorldRedo | null;
  /**
   * «Внешность» сохранённой сущности — вход перегенерации одного блока `imageBrief`: облик ТЗ берётся
   * только из неё (решение `F08 | F08-11d-2`); в остальных случаях не передаётся.
   */
  storedAppearance?: string | null;
}

export function pageWriteRequest(input: PagePromptInput): ShapedRequest {
  const briefRegen = input.regen?.block === 'imageBrief';
  const system =
    'You write the page of one character of a book for the site: the reader comes for this ' +
    'character - who they are, how they change, by which scenes and lines they are recognised. ' +
    'This is the text for publication, not a draft.\nMain rules (breaking any is a defect):\n' +
    pageRules(input.language) +
    `\n${QUALITY_BAR}\n${PAGE_FIELDS}` +
    (input.bookIsPartial
      ? '\nThe whole text with the character does not fit: you get the chapters with the most ' +
        'mentions of the character and the chapter summaries of the dossier. Quote and place ' +
        'scenes only in the chapters whose text is given.'
      : '') +
    (input.regen ? regenRule(input.regen) : '') +
    '\nBefore answering, check: the core is complete; every chapter is in the list of chapters ' +
    'with the character; every quotation is a line of this text word for word; "short" has no ' +
    'ending; no empty template values.';
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['CHARACTER', `${input.key} - ${input.name}`],
    ['NAME_FORMS', input.aliases],
    ['CHAPTERS_LIST', input.chapterList],
    ['CHAPTERS_WITH_CHARACTER', input.mentionChapters],
    ['KEYS', input.keys],
    ['ANALYSIS', input.analysis],
    ['GLOSSARY', input.glossary],
    ...regenItems(input.regen),
    ...(briefRegen ? [['APPEARANCE', input.storedAppearance || 'none'] as const] : []),
    ['EXAMPLE', input.example],
    [input.bookIsPartial ? 'CHAPTERS_AND_SUMMARIES' : 'CHAPTERS_TEXT', input.book],
  ];
  const labels = [
    'The title of the book is',
    'the author',
    'the character (key - name)',
    'the name forms of the character',
    'the chapters of this version (number - title)',
    'the chapters where the character is (number - mentions)',
    'the keys to refer to (relations, speakerKey)',
    'the analysis of this book (do not repeat it)',
    'the glossary',
    ...(input.regen ? ['the current content of the block to rewrite', 'the editor remark'] : []),
    ...(briefRegen ? ['the stored appearance of the character (the only source of the look)'] : []),
    'a sample page of another book in this language',
    'the text of the chapters with the character',
  ];
  return shapedRequest(
    WORLD_PAGE_WRITE_STAGE,
    PAGE_SHAPE,
    messages(
      system,
      items,
      leadOf(labels, 'The sample shows the form and the level only: never take its content.'),
      input.redo,
    ),
  );
}

export interface PairPromptInput {
  language: Language;
  bookTitle: string;
  author: string;
  key: string;
  first: string;
  second: string;
  chapterList: string;
  chaptersA: string;
  chaptersB: string;
  analysis: string;
  glossary: string;
  example: string;
  book: string;
  bookIsPartial: boolean;
  regen: WorldRegenSpec | null;
  redo: WorldRedo | null;
}

export function pairWriteRequest(input: PairPromptInput): ShapedRequest {
  const system =
    'You write the page of one pair of characters of a book for the site: a comparison of two ' +
    'characters - how they are alike and how they differ and why the book needs them side by ' +
    'side. The reader is a pupil writing a comparison essay or a reader who noticed that the two ' +
    'mirror each other. This is the text for publication, not a draft.\nMain rules (breaking any ' +
    'is a defect):\n' +
    pairRules(input.language) +
    `\n${PAIR_FIELDS}` +
    (input.bookIsPartial
      ? '\nThe whole text with the two characters does not fit: you get a part of the chapters ' +
        'where they are. Quote and place sides only in the chapters whose text is given.'
      : '') +
    (input.regen ? regenRule(input.regen) : '') +
    '\nBefore answering, check: the core is complete; every side of every row has a chapter ' +
    'where its character is; every quotation is a line of this text word for word, said by one ' +
    'character of the pair about the other; "short" has no ending; no empty template values.';
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['PAIR', input.key],
    ['FIRST_CHARACTER', input.first],
    ['SECOND_CHARACTER', input.second],
    ['CHAPTERS_LIST', input.chapterList],
    ['CHAPTERS_WITH_FIRST', input.chaptersA],
    ['CHAPTERS_WITH_SECOND', input.chaptersB],
    ['ANALYSIS', input.analysis],
    ['GLOSSARY', input.glossary],
    ...regenItems(input.regen),
    ['EXAMPLE', input.example],
    [input.bookIsPartial ? 'CHAPTERS_PART' : 'CHAPTERS_TEXT', input.book],
  ];
  const labels = [
    'The title of the book is',
    'the author',
    'the key of the pair',
    'the first character of the key (key - name; compare.a, chapterA)',
    'the second character of the key (key - name; compare.b, chapterB)',
    'the chapters of this version (number - title)',
    'the chapters where the first character is',
    'the chapters where the second character is',
    'the analysis of this book (do not repeat it)',
    'the glossary',
    ...(input.regen ? ['the current content of the block to rewrite', 'the editor remark'] : []),
    'a sample pair page of another book in this language',
    'the text of the chapters with the two characters',
  ];
  return shapedRequest(
    WORLD_PAIR_WRITE_STAGE,
    PAIR_SHAPE,
    messages(
      system,
      items,
      leadOf(labels, 'The sample shows the form and the level only: never take its content.'),
      input.redo,
    ),
  );
}

export interface PlacePromptInput {
  language: Language;
  bookTitle: string;
  author: string;
  key: string;
  name: string;
  aliases: string;
  chapterList: string;
  mentionChapters: string;
  keys: string;
  analysis: string;
  glossary: string;
  example: string;
  book: string;
  bookIsPartial: boolean;
  regen: WorldRegenSpec | null;
  redo: WorldRedo | null;
  /**
   * «Описание» сохранённого места — вход перегенерации одного блока `imageBrief`: вид ТЗ берётся
   * только из него (решение `F08 | F08-12b` Q2); в остальных случаях не передаётся.
   */
  storedDescription?: string | null;
}

/** Страница одного места (`F08-12b`): этап страницы, форма `PLACE_SHAPE`, эталон места языка. */
export function placeWriteRequest(input: PlacePromptInput): ShapedRequest {
  const briefRegen = input.regen?.block === 'imageBrief';
  const system =
    'You write the page of one place of a book for the site: the reader comes for this place - ' +
    'what it is, where it is, what happens here and why the book needs it. This is the text for ' +
    'publication, not a draft.\nMain rules (breaking any is a defect):\n' +
    placeRules(input.language) +
    `\n${PLACE_FIELDS}` +
    (input.bookIsPartial
      ? '\nThe whole text with the place does not fit: you get the chapters with the most ' +
        'mentions of the place and the chapter summaries of the dossier. Quote and place scenes ' +
        'only in the chapters whose text is given.'
      : '') +
    (input.regen ? regenRule(input.regen) : '') +
    // Вид и номер Wikidata - один пункт (R3): при перегенерации `kind` модель пишет оба поля.
    (input.regen?.block === 'kind'
      ? ' The block "kind" is one proposal with "wikidataId": write both.'
      : '') +
    '\nBefore answering, check: the core is complete; every chapter is in the list of chapters ' +
    'with the place; every quotation is a line of this text word for word; "short" has no ' +
    'ending; no empty template values.';
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['PLACE', `${input.key} - ${input.name}`],
    ['NAME_FORMS', input.aliases],
    ['CHAPTERS_LIST', input.chapterList],
    ['CHAPTERS_WITH_PLACE', input.mentionChapters],
    ['KEYS', input.keys],
    ['ANALYSIS', input.analysis],
    ['GLOSSARY', input.glossary],
    ...regenItems(input.regen),
    ...(briefRegen ? [['DESCRIPTION', input.storedDescription || 'none'] as const] : []),
    ['EXAMPLE', input.example],
    [input.bookIsPartial ? 'CHAPTERS_AND_SUMMARIES' : 'CHAPTERS_TEXT', input.book],
  ];
  const labels = [
    'The title of the book is',
    'the author',
    'the place (key - name)',
    'the name forms of the place',
    'the chapters of this version (number - title)',
    'the chapters where the place is (number - mentions)',
    'the keys to refer to (speakerKey)',
    'the analysis of this book (do not repeat it)',
    'the glossary',
    ...(input.regen ? ['the current content of the block to rewrite', 'the editor remark'] : []),
    ...(briefRegen ? ['the stored description of the place (the only source of the look)'] : []),
    'a sample place page of another book in this language',
    'the text of the chapters with the place',
  ];
  return shapedRequest(
    WORLD_PAGE_WRITE_STAGE,
    PLACE_SHAPE,
    messages(
      system,
      items,
      leadOf(labels, 'The sample shows the form and the level only: never take its content.'),
      input.redo,
    ),
  );
}

/** «Главные правила» страницы предмета и понятия (`F08-13b`, `product.md` §7) по тексту версии. */
function objectRules(language: Language, type: WorldRunObjectType): string {
  const what = type === 'object' ? 'object' : 'term';
  return numbered([
    type === 'object'
      ? 'An object of the book, not a retelling: what the thing is, whose it is, where it appears ' +
        'and what it means for the book. Name a scene only as much as it shows the object. Do not ' +
        'repeat the analysis, the summary or the character pages.'
      : 'A term of the book for a reader who meets an unfamiliar word: what it means in this book ' +
        'and in its time, and why the book needs it. Not a retelling and not an essay.',
    `Every statement rests on a detail of the text of this version with its chapter number from ` +
      `the list of chapters; the chapters where the ${what} is are given.`,
    type === 'object'
      ? '"short" - 2-3 sentences without the ending: what this thing is and who has it. No ' +
        'outcome, no turn of the last third.'
      : '"short" - the glossary definition: 1-2 sentences, what the word means, then whom or what ' +
        'it concerns in the book. No outcome, no turn of the last third.',
    'Quotations only word for word from the text of this version given in the data, with the ' +
      `number of the chapter where the words stand - words that name or show the ${what}. Not ` +
      'sure - leave the quotation out. No quotations in quotation marks inside the prose fields.',
    'Do not invent: no dates, history, sources or links beyond the text of this version. Present ' +
      'the disputable as an interpretation ("can be read as…").',
    `Write for the reader of ${LANGUAGE_NAMES[language]} (language code "${language}"), not a ` +
      'translation from English. Names as in the glossary and in the known translations.',
    'Plain text: no HTML, no Markdown, no emoji. Paragraphs of a long text are separated by an ' +
      `empty line. Quotation marks of the language: ${QUOTE_MARKS[language]}.`,
    'Do not speak for the site: no "our editors think".',
  ]);
}

const OBJECT_FIELDS =
  'The core - without it there is no page: short and significance.' +
  `\nname - the name of the object as in the text of this version (at most ${L.name} characters). ` +
  `short - at most ${L.short} characters. significance - what the object means for the book, a ` +
  `thesis with its chapters, at most ${L.significance}. description - how the object looks and ` +
  `where it is kept, only what the text says, at most ${L.description}, or "". quotes - at most ` +
  `${L.quotes}, each at most ${L.quote} characters; speakerKey - the key of the speaker from KEYS, ` +
  'or "" when the narrator speaks; interpretation - 1-3 sentences: what the line shows about the ' +
  `object. faq - at most ${L.faq} questions as a reader of this language searches for them, the ` +
  `answer direct in its first sentence. characterKeys - at most ${L.characterKeys} keys from the ` +
  'WORLD_CHARACTERS block: the characters this object belongs to or acts with; another key is ' +
  `thrown away. themeKeys - at most ${L.themeKeys} keys from the THEMES block: the themes of the ` +
  'analysis the object stands for; another key is thrown away.' +
  '\nA field without reliable data - "" or an empty list.';

const TERM_FIELDS =
  'The core - without it there is no page: short.' +
  `\nname - the term as the text of this version writes it (at most ${L.name} characters). short - ` +
  `the glossary definition, at most ${L.short} characters. significance - why the book needs the ` +
  `term, with its chapters, at most ${L.significance}, or "". quotes - at most ${L.quotes}, each at ` +
  `most ${L.quote} characters; speakerKey - the key of the speaker from KEYS, or "" when the ` +
  'narrator speaks; interpretation - 1-3 sentences: what the line shows about the term.' +
  '\nA term page has no other fields.\nA field without reliable data - "" or an empty list.';

export interface ObjectPromptInput {
  language: Language;
  type: WorldRunObjectType;
  bookTitle: string;
  author: string;
  key: string;
  name: string;
  aliases: string;
  chapterList: string;
  mentionChapters: string;
  keys: string;
  /** Сохранённые герои мира версии «ключ - имя» (`characterKeys`, только у предмета). */
  worldCharacters: string;
  /** Темы анализа версии «ключ - название» (`themeKeys`, только у предмета). */
  themes: string;
  analysis: string;
  glossary: string;
  example: string;
  book: string;
  bookIsPartial: boolean;
  regen: WorldRegenSpec | null;
  redo: WorldRedo | null;
}

/**
 * Страница одного предмета или понятия (`F08-13b`): этап страницы, форма своего типа (`OBJECT_SHAPE`,
 * `TERM_SHAPE`), эталон типа языка; предмету - герои мира и темы анализа с ключами (Q5).
 */
export function objectWriteRequest(input: ObjectPromptInput): ShapedRequest {
  const object = input.type === 'object';
  const what = object ? 'object' : 'term';
  const system =
    (object
      ? 'You write the page of one object of a book for the site: the reader comes for this ' +
        'thing - what it is, whose it is, where it appears and why the book needs it.'
      : 'You write the page of one term of a book for the site: the reader comes for the meaning ' +
        'of an unfamiliar word of this book.') +
    ' This is the text for publication, not a draft.\nMain rules (breaking any is a defect):\n' +
    objectRules(input.language, input.type) +
    `\n${object ? OBJECT_FIELDS : TERM_FIELDS}` +
    (input.bookIsPartial
      ? `\nThe whole text with the ${what} does not fit: you get the chapters with the most ` +
        `mentions of the ${what} and the chapter summaries of the dossier. Quote only the ` +
        'chapters whose text is given.'
      : '') +
    (input.regen ? regenRule(input.regen) : '') +
    '\nBefore answering, check: the core is complete; every quotation is a line of this text word ' +
    'for word; "short" has no ending; no empty template values.';
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    [object ? 'OBJECT' : 'TERM', `${input.key} - ${input.name}`],
    ['NAME_FORMS', input.aliases],
    ['CHAPTERS_LIST', input.chapterList],
    [object ? 'CHAPTERS_WITH_OBJECT' : 'CHAPTERS_WITH_TERM', input.mentionChapters],
    ['KEYS', input.keys],
    ...(object
      ? ([
          ['WORLD_CHARACTERS', input.worldCharacters],
          ['THEMES', input.themes],
        ] as const)
      : []),
    ['ANALYSIS', input.analysis],
    ['GLOSSARY', input.glossary],
    ...regenItems(input.regen),
    ['EXAMPLE', input.example],
    [input.bookIsPartial ? 'CHAPTERS_AND_SUMMARIES' : 'CHAPTERS_TEXT', input.book],
  ];
  const labels = [
    'The title of the book is',
    'the author',
    `the ${what} (key - name)`,
    `the name forms of the ${what}`,
    'the chapters of this version (number - title)',
    `the chapters where the ${what} is (number - mentions)`,
    'the keys to refer to (speakerKey)',
    ...(object
      ? [
          'the characters of the world of this version (key - name; characterKeys)',
          'the themes of the analysis (key - title; themeKeys)',
        ]
      : []),
    'the analysis of this book (do not repeat it)',
    'the glossary',
    ...(input.regen ? ['the current content of the block to rewrite', 'the editor remark'] : []),
    `a sample ${what} page of another book in this language`,
    `the text of the chapters with the ${what}`,
  ];
  return shapedRequest(
    WORLD_PAGE_WRITE_STAGE,
    object ? OBJECT_SHAPE : TERM_SHAPE,
    messages(
      system,
      items,
      leadOf(labels, 'The sample shows the form and the level only: never take its content.'),
      input.redo,
    ),
  );
}

export interface ExternalPromptInput {
  language: Language;
  bookTitle: string;
  author: string;
  originalLanguage: string;
  name: string;
  page: string;
  regen: WorldRegenSpec | null;
  redo: WorldRedo | null;
}

export function externalWriteRequest(input: ExternalPromptInput): ShapedRequest {
  const system =
    'You write a part of the page of one character of a book for the site.\nMain rules ' +
    '(breaking any is a defect):\n' +
    externalRules(input.language) +
    (input.regen ? regenRule(input.regen) : '') +
    '\nBefore answering, check: every statement has refs to sources of your list; every source ' +
    'has a full https address; no quotation of the book; no empty template values.';
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['ORIGINAL_LANGUAGE', input.originalLanguage || 'unknown'],
    ['CHARACTER', input.name],
    ['CHARACTER_PAGE', input.page],
    ...regenItems(input.regen),
    ['EXAMPLE', EXTERNAL_SAMPLE],
  ];
  const labels = [
    'The title of the book is',
    'the author',
    'the language of the original',
    'the character',
    'the page of the character written from the text',
    ...(input.regen ? ['the current content of the block to rewrite', 'the editor remark'] : []),
    'a sample of the answer form',
  ];
  return shapedRequest(
    WORLD_EXTERNAL_WRITE_STAGE,
    EXTERNAL_SHAPE,
    messages(
      system,
      items,
      leadOf(labels, 'The sample shows the form only: never take its content or its addresses.'),
      input.redo,
    ),
  );
}

const REVIEW_STEP: Record<WorldWrittenStepKind, string> = {
  select: 'the name forms of the characters',
  page: 'the page of one character',
  external: 'the external blocks of one character page (criticism, prototypes, adaptations)',
  pair: 'the page of one pair of characters (a comparison of the two)',
  place: 'the page of one place of the book',
  object: 'the page of one object of the book',
  term: 'the page of one term of the book (a glossary entry)',
};

/** Правила, по которым проверяющая читает ответ шага: свои у каждого вида. */
function reviewRules(kind: WorldWrittenStepKind, language: Language): string {
  switch (kind) {
    case 'page':
      return `${pageRules(language)}\n${QUALITY_BAR}`;
    case 'pair':
      return `${pairRules(language)}\n${PAIR_FIELDS}`;
    case 'place':
      return `${placeRules(language)}\n${PLACE_FIELDS}`;
    // Поля по типу (`F08-13b`): у понятия «Коротко» - определение глоссария, других полей нет.
    case 'object':
      return `${objectRules(language, 'object')}\n${OBJECT_FIELDS}`;
    case 'term':
      return `${objectRules(language, 'term')}\n${TERM_FIELDS}`;
    case 'select':
      return SELECT_RULES;
    case 'external':
      return externalRules(language);
  }
}

/** Виды шага, у которых «Коротко» проверяется на исход (`SHORT_SPOILER`). */
const SPOILER_KINDS: ReadonlySet<WorldWrittenStepKind> = new Set([
  'page',
  'pair',
  'place',
  'object',
  'term',
]);

export interface WorldReviewInput {
  kind: WorldWrittenStepKind;
  language: Language;
  book: string;
  analysis: string;
  answer: unknown;
  regenBlock: WorldBlock | null;
}

export function worldReviewRequest(input: WorldReviewInput): ShapedRequest {
  const external = input.kind === 'external';
  const system =
    `You check ${REVIEW_STEP[input.kind]} of a book written for publication on the site. ` +
    (external
      ? 'The text of the book is not given: compare the answer with what is reliably known ' +
        'about the book and list what is wrong. '
      : 'Compare the answer with the text given and list what is wrong. ') +
    (input.regenBlock
      ? `Only the block "${input.regenBlock}" was rewritten, the answer holds only it: check ` +
        'only it. '
      : '') +
    `The rules the answer must follow:\n${reviewRules(input.kind, input.language)}` +
    '\nRemark codes:' +
    (external
      ? ''
      : '\n- NOT_IN_TEXT: a detail, a scene or a name form that is not in the text (who, where, ' +
        'what happened, in which chapter).') +
    '\n- GENERIC: the text is true for any character (replace the name - nothing changes).' +
    '\n- CONTRADICTION: the fields contradict each other or the analysis of the book.' +
    '\n- RETELLING: a retelling of the plot instead of a characterisation.' +
    (SPOILER_KINDS.has(input.kind)
      ? '\n- SHORT_SPOILER: "short" tells the outcome, the ending or a turn of the last third. ' +
        'where: short.'
      : '') +
    '\n- STYLE_POOR: clichés, empty praise, officialese, calques.' +
    (external
      ? '\n- EXTERNAL_DOUBT: an external statement is doubtful (a date, a name, the fact of an ' +
        'adaptation). where: the path of the statement - critique, prototypes, adaptations.N.'
      : '') +
    '\nwhere - the path of the field (short, character, scenes.2, quotes.0) or a short fragment. ' +
    'No remarks - verdict ok and an empty list.';
  const items: Array<readonly [string, string]> = [
    ['ANALYSIS', input.analysis],
    ['TEXT', input.book],
    ['ANSWER', JSON.stringify(input.answer)],
  ];
  const fences = fenceAll(items, []);
  const [analysis, text, answer] = fences;
  return shapedRequest(WORLD_REVIEW_STAGE, WORLD_REVIEW_SHAPE, [
    { role: 'system', content: `${system}\n\n${FENCE_RULE}` },
    {
      role: 'user',
      content:
        `The analysis of the book is in ${analysis.name}, the text in ${text.name}, the answer ` +
        `to check in ${answer.name}.\n\n${fences.map((f) => f.block).join('\n\n')}`,
    },
  ]);
}
