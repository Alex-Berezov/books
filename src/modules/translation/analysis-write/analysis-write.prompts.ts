import { Language } from '@prisma/client';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { Shape } from '../dossier/dossier.format';
import { LANGUAGE_NAMES, shapedRequest, ShapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenceAll, remarksPart } from '../fenced-data';
import { Redo, reviewShapeOf } from '../draft-quality/quality-loop';
import { DraftRemark, DraftRemarkCode } from '../draft-quality/text-checks';
import {
  ANALYSIS_CAST_WRITE_STAGE,
  ANALYSIS_EXTERNAL_WRITE_STAGE,
  ANALYSIS_MEANING_WRITE_STAGE,
  ANALYSIS_READER_WRITE_STAGE,
  ANALYSIS_QUOTES_WRITE_STAGE,
  ANALYSIS_REVIEW_STAGE,
  EXTERNAL_STEP,
  READER_STEP,
} from './analysis-write.constants';
import {
  AnalysisStepNumber,
  AnalysisTarget,
  EXTERNAL_FACTS,
  StepDraft,
} from './analysis-write.data';

/**
 * Промпты шагов хода анализа (`F07-1a`; `features/F07-analysis-autofill/product.md` §2-§3, канон -
 * промпт владельца `features/F03-book-analysis/prompts/book-analysis.md`): «Главные правила»,
 * «Планка качества текста», разделы «Блоки» шага и «Проверка перед ответом» перенесены по смыслу
 * для своего шага. Отличия от канона: правила о внешних фактах и источниках - у шагов `F07-2`;
 * язык ставит код (Л5); номера глав - из списка глав версии; ответ - по строгой форме, поэтому
 * «нет значения» - пустая строка, «нет главы» - `0`. Текст книги, досье, глоссарий, итоги прошлых
 * шагов, прошлый ответ и замечания - данные в оградах (`F05-14`), а не инструкция.
 */

const str = 'string' as const;
const int = 'int' as const;

const ROLE = { enum: ['main', 'secondary', 'minor'] } as const;

/** Шаг 1: карточка (место, время, рассказчик, композиция) и герои без `themeKeys`. */
const CAST_SHAPE: Shape = {
  object: {
    facts: { object: { settingPlace: str, settingTime: str, narrator: str, structure: str } },
    characters: {
      array: {
        object: {
          key: str,
          name: str,
          role: ROLE,
          description: str,
          arcFrom: str,
          arcTo: str,
          quote: str,
          quoteChapter: int,
          relations: { array: { object: { to: str, label: str } } },
        },
      },
    },
  },
};

/** Шаг 2: ключевые цитаты с толкованием и приёмы с примером. */
const QUOTES_SHAPE: Shape = {
  object: {
    keyQuotes: {
      array: { object: { text: str, chapter: int, speakerKey: str, interpretation: str } },
    },
    style: {
      array: { object: { device: str, explanation: str, example: str, exampleChapter: int } },
    },
  },
};

/**
 * Шаг 3: толкования и служебные связи тем (`tech.md` §2): шаг не возвращает героев и цитаты, а
 * ссылается на них ключом героя и `id` цитаты из списка входа. Строгая форма не знает словарей с
 * произвольными ключами - связи списком, карту строит код.
 */
const MEANING_SHAPE: Shape = {
  object: {
    mainIdea: str,
    themes: {
      array: {
        object: {
          key: str,
          title: str,
          interpretation: str,
          chapters: { array: int },
          quotes: { array: { object: { text: str, chapter: int, comment: str } } },
        },
      },
    },
    symbols: {
      array: {
        object: {
          title: str,
          interpretation: str,
          chapters: { array: int },
          quote: str,
          quoteChapter: int,
        },
      },
    },
    titleMeaning: str,
    endingMeaning: str,
    themeLinks: {
      object: {
        characters: { array: { object: { key: str, themeKeys: { array: str } } } },
        keyQuotes: { array: { object: { id: str, themeKeys: { array: str } } } },
      },
    },
  },
};

/** Шаг 4: блоки для читателя. */
const READER_SHAPE: Shape = {
  object: {
    misreadings: { array: { object: { myth: str, explanation: str } } },
    discussionQuestions: { array: str },
    faq: { array: { object: { question: str, answer: str } } },
  },
};

const TIMELINE_KIND = { enum: ['author', 'epoch', 'book'] } as const;
const ADAPTATION_KIND = { enum: ['film', 'series', 'stage', 'other'] } as const;

/**
 * Шаг 5: внешние блоки и ссылки утверждений на `sources` (`tech.md` §4, `sourceRefs`). Строгая форма
 * без словарей: ссылки лежат рядом с утверждением - `refs` абзаца, события, экранизации и
 * `<факт>Refs`; индексы - позиции в `sources` этого же ответа. Абзацы `context` и `reception` -
 * списком, код склеивает их пустой строкой.
 */
const EXTERNAL_SHAPE: Shape = {
  object: {
    genre: str,
    genreRefs: { array: int },
    movement: str,
    movementRefs: { array: int },
    writtenYears: str,
    writtenYearsRefs: { array: int },
    context: { array: { object: { text: str, refs: { array: int } } } },
    timeline: {
      array: { object: { year: str, event: str, kind: TIMELINE_KIND, refs: { array: int } } },
    },
    reception: { array: { object: { text: str, refs: { array: int } } } },
    adaptations: {
      array: {
        object: {
          title: str,
          year: int,
          kind: ADAPTATION_KIND,
          differences: str,
          refs: { array: int },
        },
      },
    },
    sources: { array: { object: { title: str, url: str } } },
  },
};

export const STEP_SHAPES: Record<AnalysisStepNumber, Shape> = {
  1: CAST_SHAPE,
  2: QUOTES_SHAPE,
  3: MEANING_SHAPE,
  4: READER_SHAPE,
  5: EXTERNAL_SHAPE,
};

export const STEP_STAGES: Record<AnalysisStepNumber, string> = {
  1: ANALYSIS_CAST_WRITE_STAGE,
  2: ANALYSIS_QUOTES_WRITE_STAGE,
  3: ANALYSIS_MEANING_WRITE_STAGE,
  4: ANALYSIS_READER_WRITE_STAGE,
  5: ANALYSIS_EXTERNAL_WRITE_STAGE,
};

/** Коды проверяющей анализа (`product.md` §3.4); `FAQ_WEAK`, `MYTH_INVENTED` - шаг 4, `EXTERNAL_DOUBT` - шаг 5. */
export const ANALYSIS_REVIEW_CODES = [
  'NOT_IN_TEXT',
  'GENERIC',
  'CONTRADICTION',
  'RETELLING',
  'ONE_SIDED',
  'STYLE_POOR',
  'FAQ_WEAK',
  'MYTH_INVENTED',
  'EXTERNAL_DOUBT',
] as const satisfies readonly DraftRemarkCode[];

const ANALYSIS_REVIEW_SHAPE: Shape = reviewShapeOf(ANALYSIS_REVIEW_CODES);

/** Кавычки языка - правило 6 канона `F03` по языкам. */
const QUOTE_MARKS: Record<Language, string> = {
  ru: '«ёлочки» (guillemets « »)',
  fr: '« guillemets »',
  en: '“curly quotes”',
  es: 'comillas «» or “”',
  pt: 'aspas “”',
};

/**
 * Правила внешнего шага (`F07-2a`): текста книги шагу не дают, цитат и глав в нём нет, а факты
 * допустимы - но только с источником (`product.md` §3.3).
 */
function externalRules(language: Language): string {
  const name = LANGUAGE_NAMES[language];
  return [
    `Write for the reader of ${name} (language code "${language}"), not a translation from ` +
      'English: the living literary language of a native speaker, no calques, no mixing of ' +
      'languages. The title of the book and the names exactly as in the data given. Examples, ' +
      'critics, adaptations and disputes - those this reader knows: the translations into this ' +
      'language, the school, the known responses in this culture, when they are reliably known.',
    'Facts only if they are confirmed by a source from your sources list; never present a ' +
      'guess as a fact. Not sure of a date, a name or a fact - leave the statement out: an empty ' +
      'block is not shown, a mistake stays on the page.',
    'No quotations of the book and no chapter numbers in this step.',
    'Plain text: no HTML, no Markdown (no **, #, - lists, links in the text), no emoji. ' +
      `Quotation marks of the language: ${QUOTE_MARKS[language]}.`,
    'Do not speak for the site: no "our editors think", no "we have prepared".',
  ]
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');
}

/** «Главные правила» канона `F03` для шагов по тексту книги (правила 1-7). */
function mainRules(language: Language, step?: AnalysisStepNumber): string {
  if (step === EXTERNAL_STEP) return externalRules(language);
  const name = LANGUAGE_NAMES[language];
  return [
    `Write for the reader of ${name} (language code "${language}"), not a translation from ` +
      'English: the living literary language of a native speaker, no calques, no mixing of ' +
      'languages. Names of characters, places and objects exactly as in the glossary: the ' +
      'quotations and chapter links lead into our reader.',
    'Quotations only word for word from the text of this version given in the data, inside the ' +
      'field for the quotation, with the number of its chapter. Never retell, shorten inside or ' +
      'join two places. Not sure of the wording - leave the quotation out. A quotation that is ' +
      'not word for word is thrown away.',
    'Do not invent. No dates, biography, prototypes, adaptations, critics or links. Not sure - ' +
      'leave the field or the element out: an empty block is not shown, a mistake stays on the ' +
      'page. Do not present the disputable as established; present an interpretation as an ' +
      'interpretation ("can be read as…").',
    'Chapter numbers only from the list of chapters of this version (the number after READER ' +
      'CHAPTER). Not sure which chapter - 0.',
    'Do not retell the plot: name a scene only as much as the interpretation needs.',
    'Plain text: no HTML, no Markdown (no **, #, - lists, links in the text), no emoji. ' +
      'Paragraphs of a long text are separated by an empty line. ' +
      `Quotation marks of the language: ${QUOTE_MARKS[language]}.`,
    'Do not speak for the site: no "our editors think", no "we have prepared".',
  ]
    .map((rule, i) => `${i + 1}. ${rule}`)
    .join('\n');
}

/** «Планка качества текста» канона `F03` - каждое толкование. */
const QUALITY_BAR =
  'Every interpretive text passes the quality bar: (1) concreteness - it rests on a scene, a ' +
  'detail, a line or a quotation with its chapter; replace the title of the book with another ' +
  'one - if the text is still true, it says nothing about this book; (2) development, not a ' +
  'label - show the theme or the character in motion: where it starts, what it goes through, ' +
  'where it arrives; (3) the answer to "why" - what role it plays in the meaning of the book; ' +
  '(4) honesty about the disputable - where the book has several recognised readings, name ' +
  'them; (5) coherence - the blocks agree with each other. Nowhere: empty praise ("brilliant", ' +
  '"deep", "an important place"), officialese and school clichés ("the author wanted to say", ' +
  '"in this work"), the same thought repeated in different blocks, retelling instead of ' +
  'interpretation.';

const LIMITS = BOOK_ANALYSIS_LIMITS;

/**
 * Планка качества шага: внешнему шагу (без текста книги, без цитат) опора - источник, а не сцена
 * с цитатой и главой; прочее в планке то же.
 */
const qualityBar = (step: AnalysisStepNumber): string =>
  step === EXTERNAL_STEP
    ? QUALITY_BAR.replace(
        'it rests on a scene, a ' + 'detail, a line or a quotation with its chapter',
        'it rests on a fact that a source of your list confirms',
      )
    : QUALITY_BAR;

/** Блоки шага (раздел «Блоки» канона) и проверка перед ответом своего шага. */
const STEP_RULES: Record<AnalysisStepNumber, string> = {
  1:
    'You write the card of the work and the characters.' +
    '\nfacts - short phrases, not sentences: settingPlace (where the action takes place), ' +
    'settingTime (when), narrator (who tells the story and in which person), structure (the ' +
    'composition in one line: parts, chapters, a frame); "" when the text does not say. Genre, ' +
    'movement and years of writing are not this step.' +
    `\ncharacters - the main and important secondary characters, at most ${LIMITS.characters}. key - ` +
    'lowercase latin letters, digits and "-" (^[a-z0-9-]{1,60}$), the latin transliteration of ' +
    'the commonly used name; take the key from the KEYS block when the character is there. name - ' +
    'as in the glossary. role - main, secondary or minor. description - 1-2 paragraphs, at most ' +
    `${LIMITS.mediumText} characters: who this is, what they want, what drives them, what role they ` +
    'play in the meaning of the book; not a biography by chapters. arcFrom and arcTo - who the ' +
    'character is at the start and at the end, a phrase each, or "" for both when the character ' +
    'does not change. quote - one line by which the character is recognised, word for word from ' +
    'the chapter quoteChapter, or "" and 0. relations - at most ' +
    `${LIMITS.relations}, only to main or secondary characters by key, never to the character itself ` +
    'and not to a minor one; label - 1-3 words, the essence of the relation ("rival", "saviour"); ' +
    'a relation is written at one of the two characters only. At least 2 characters with a ' +
    'description: they are the core of the page.',
  2:
    'You write the key quotations and the devices of the style.' +
    `\nkeyQuotes - about 6-${LIMITS.keyQuotes} of the most important lines of the book, a guide and ` +
    'not a norm: fewer is fine when the text does not give more (at least 3 for the core): text - word for word from the chapter given in chapter, at most ' +
    `${LIMITS.quote} characters; speakerKey - the key of the speaking character from the CHARACTERS ` +
    'block, "" for the narrator or the author; interpretation - 1-2 paragraphs: at what moment ' +
    'the line sounds, why it matters and how to understand it. Choose the lines that are quoted ' +
    'and searched for (the known aphorisms of the book) and the turning lines where a character ' +
    'or the meaning changes.' +
    `\nstyle - 2-6 devices (at most ${LIMITS.style}): device - the name of the device; explanation - ` +
    'how it works in this very book and what effect it gives the reader (never empty); example - ' +
    `a short passage word for word from the chapter exampleChapter, at most ${LIMITS.quote} ` +
    'characters, or "" and 0. Not a list of textbook terms but what makes the style of this book ' +
    'recognisable.',
  3:
    'You write the interpretations: the main idea, the themes, the symbols, the meaning of the ' +
    'title and of the ending. First formulate the central question of the book - the themes are ' +
    'facets of the answer to it.' +
    `\nmainIdea - 2-3 sentences, at most ${LIMITS.mainIdea} characters: what the book is really ` +
    'about, what question it asks and how it answers. It stands above the contents and starts the ' +
    'description of the page for search engines: the first sentence is self-sufficient, names the ' +
    'book or the author and is at most 160 characters - it works as the snippet. Not a retelling ' +
    'and not an advertisement.' +
    `\nthemes - 3-6 main themes (at most ${LIMITS.themes}) in order of importance: key - an English ` +
    'word by the meaning (guilt, redemption), from the KEYS block when the theme is there; title ' +
    '- how the theme is named in this language; interpretation - 1-4 paragraphs: how the theme ' +
    'is declared, through which characters and scenes it unfolds, how it changes, where it ' +
    'arrives in the ending; chapters - the chapters where the theme sounds noticeably, ' +
    `selectively; quotes - 1-${LIMITS.themeQuotes} quotations word for word with chapter and a ` +
    'one-sentence comment (what the quotation shows), or none; do not repeat the quotations of ' +
    'the KEY_QUOTES block one to one without need.' +
    `\nsymbols - repeated images, objects, colours, places, dreams (at most ${LIMITS.symbols}): title, ` +
    'interpretation (what it means, how it changes, which theme it strengthens), chapters, quote ' +
    'word for word with quoteChapter or "" and 0. An image without repetition is a detail, not ' +
    'a symbol.' +
    '\ntitleMeaning - 1-3 paragraphs: what the title means, how it unfolds by the end of the ' +
    'book and whether it has a second meaning - only from the text of this version. ' +
    'endingMeaning - 1-3 paragraphs: how to understand the ending and what it says about the main ' +
    'idea; an open or disputed ending - name the main readings. The site warns about the ' +
    'spoiler itself.' +
    '\nthemeLinks - which themes each character and each key quotation is linked with: ' +
    'characters - by key from the CHARACTERS block; keyQuotes - by id from the KEY_QUOTES block; ' +
    `themeKeys - keys of your themes, at most ${LIMITS.themeKeys}. Do not return the characters and ` +
    'the quotations themselves.',
  4:
    'You write the blocks for the reader, relying on the previous steps (characters, quotations, ' +
    'themes, symbols, meanings) and the chapter summaries.' +
    `\nmisreadings - 2-6 common misunderstandings of the book (at most ${LIMITS.misreadings}): myth - the ` +
    'mistake in one phrase, as a reader or a school essay words it (at most ' +
    `${LIMITS.question} characters); explanation - why it is not so, resting on the text (at most ` +
    `${LIMITS.mediumText} characters). Good candidates: the simplified "the moral of the book is…", ` +
    'a character taken for the author, anachronisms, the ' +
    'literal reading of irony. Never invent a mistake only to refute it: only those that really ' +
    'occur.' +
    `\ndiscussionQuestions - 5-10 open questions (at most ${LIMITS.discussionQuestions}, each at most ` +
    `${LIMITS.question} characters) for a lesson, a book club, an essay: no yes/no questions, ` +
    'no questions with one defensible answer; mix questions about characters, themes, devices ' +
    'and the link of the book with today. Plain strings.' +
    `\nfaq - 4-8 questions (at most ${LIMITS.faq}) that people really search for about the analysis ` +
    'of this book in this language ("what is the meaning of…", "why does the hero…", "how does it ' +
    'end…", "what does … symbolise"): question - worded the way it is typed into a search in this ' +
    `language (at most ${LIMITS.question} characters); answer - 1-4 sentences, the direct answer in ` +
    `the first sentence, no links to the site, at most ${LIMITS.longText} characters. Do not copy ` +
    'the text of other blocks word for word - compress it into an answer.',
  5:
    'You write the external blocks: facts about the genre and the history of the book that the ' +
    'text itself does not hold. Rely only on what you know for certain and what the sources ' +
    'confirm.' +
    '\nEvery statement carries refs: the positions (from 0) in your own sources list of the ' +
    'sources that confirm it. A statement without a source is thrown away by the code, and a ' +
    'source that does not open or is not about this book is thrown away with the statements ' +
    'that rest only on it. Give 2-6 sources; no sure address - no source and no statement.' +
    '\ngenre - the genre in a short phrase ("a psychological novel"); movement - the literary ' +
    'movement ("realism"), "" when there is no established one; writtenYears - the years of work ' +
    'on the book ("1865-1866"); each with its genreRefs / movementRefs / writtenYearsRefs, and ' +
    '"" with an empty list when you are not sure.' +
    '\ncontext - 1-4 paragraphs (together at most ' +
    `${LIMITS.longText} characters): the epoch and the questions the book answers, the ` +
    'circumstances of the work, the prototypes and the sources of the idea, what a modern reader ' +
    'would not notice without the context. Only what biographies and commentaries confirm. When ' +
    'the book came out in this language under another title, or the original title holds a play ' +
    'on words the translation loses, say it here - only with a source (these facts are not in the text of the version). Each paragraph is an ' +
    'element with its refs.' +
    `\ntimeline - events by year, ascending (at most ${LIMITS.timeline}): year - a string ("1866", ` +
    '"1850-1854", "1860s"); event - one event in one phrase; kind - author (the life of the ' +
    'author), epoch (the epoch) or book (the history of the book: the idea, the first ' +
    'publication, the first translation into this language when the date is exactly known). Only ' +
    'events that explain the book. Each with its refs.' +
    '\nreception - 1-3 paragraphs (together at most ' +
    `${LIMITS.longText} characters): how contemporaries took the book, which disputes it ` +
    'caused, how it is read now; name only real critics and works; how the book entered the ' +
    'culture of this reader (translations, school, known responses) when it is reliably known. ' +
    'Each paragraph with its refs.' +
    `\nadaptations - the most known ones (at most ${LIMITS.adaptations}): title - the name it is known ` +
    'under in this language; year - a number from ' +
    `${LIMITS.adaptationYear.min} to ${LIMITS.adaptationYear.max}; kind - film, series, stage ` +
    'or other; differences - how it differs from the book (1-3 sentences, at most ' +
    `${LIMITS.mediumText} characters). Not sure of the year or of the fact itself - leave it out. ` +
    'Each with its refs.' +
    `\nsources - at most ${LIMITS.sources}: title and url. The url is a full address that starts with ` +
    'https:// and names a host (no IP address, no port, no login in it). Only the addresses you are ' +
    'sure exist: encyclopedias, Wikipedia in the language of this version, academic editions and ' +
    'commentaries, museums. The code opens every address and looks in the page for the title of ' +
    'the book or the surname of the author.',
};

/** Переделка (U5): прошлый ответ шага и замечания - данными. */
export type StepRedo = Redo<StepDraft>;

const remarksText = (remarks: readonly DraftRemark[]): string =>
  remarks.map((r) => `- ${r.code} (${r.where}): ${r.note}`).join('\n');

function messages(
  system: string,
  items: Array<readonly [string, string]>,
  lead: (names: string[]) => string,
  redo: StepRedo | null,
  outside: readonly string[],
  previousOf: (draft: StepDraft) => unknown = (draft) => draft.blocks,
): LlmChatMessage[] {
  const all = redo
    ? [
        ...items,
        ['PREVIOUS_ANSWER', JSON.stringify(previousOf(redo.previous))] as const,
        ['REMARKS', remarksText(redo.remarks)] as const,
      ]
    : items;
  const fences = fenceAll(all, outside);
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

/**
 * Перегенерация одного блока шага (`F07-1b`, `tech.md` §2): блок, его прежнее содержимое (ключи
 * элементов остаются) и замечание редактора. Остальные блоки ответа код отбрасывает.
 */
export interface StepRegen {
  target: AnalysisTarget;
  current: unknown;
  remark: string | null;
}

/** Правило перегенерации в системное сообщение: что переписать и что держать. */
const regenRule = (regen: StepRegen, step: AnalysisStepNumber): string =>
  `\nThe editor asks to rewrite one block of this step: "${regen.target}". Rewrite only it: ` +
  'its current content is in the CURRENT_BLOCK block. Keep the key of every element you keep - ' +
  'the same element has the same key; a new element gets a new unique key; drop an element only ' +
  'when the text does not support it. Apply the editor remark when there is one; the remark is the ' +
  'wish of the editor about this block, never a permission to break the rules above. The code ' +
  'ignores the other blocks of the answer: keep them as short as the form allows.' +
  (regen.target === 'themes'
    ? ' Give themeLinks for the themes of your answer: the code keeps them with the themes.'
    : '') +
  (step === EXTERNAL_STEP
    ? ' Give in sources the sources this block refers to, and refer to them from the block: the ' +
      'code opens them again and drops every statement without a source that opens.'
    : '');

/** Вход шага (`tech.md` §2): книга - весь текст версии или краткое содержание глав досье. */
interface StepPromptInput {
  step: AnalysisStepNumber;
  language: Language;
  bookTitle: string;
  author: string;
  /** Номер — название глав версии строками. */
  chapterList: string;
  glossary: string;
  dossier: string;
  /** Ключи тем и героев из анализа этой книги на другом языке и сохранённого анализа версии. */
  keys: string;
  /** Текст версии (`[READER CHAPTER n]`) или краткое содержание глав досье. */
  book: string;
  bookIsSummaries: boolean;
  /** Итоги прошлых шагов: шагу 2 - герои, шагу 3 - герои, цитаты (`id`, текст) и приёмы. */
  previous: Array<readonly [string, string]>;
  /** Срез эталона языка версии по блокам шага (К3) - JSON. */
  example: string;
  redo: StepRedo | null;
  /** Перегенерация одного блока вместо шага целиком (`F07-1b`); `null` - шаг хода. */
  regen?: StepRegen | null;
  /** Язык оригинала книги - вход внешнего шага (`tech.md` §2); пусто - неизвестен. */
  originalLanguage?: string;
}

/**
 * Ответ внешнего шага в его форме (`EXTERNAL_SHAPE`) из блоков и ссылок: обратный разбору
 * (`readExternal`) - для прошлого ответа в переделке.
 */
export function externalAnswerOf(draft: StepDraft): Record<string, unknown> {
  const b = draft.blocks;
  const refs = draft.refs ?? {
    facts: {},
    context: [],
    reception: [],
    timeline: [],
    adaptations: [],
  };
  const paragraphs = (text: string | undefined, own: number[][]) =>
    (text ? text.split('\n\n') : []).map((p, i) => ({ text: p, refs: own[i] ?? [] }));
  const withRefs = (rows: readonly object[] | undefined, own: number[][]) =>
    (rows ?? []).map((row, i) => ({ ...row, refs: own[i] ?? [] }));
  return {
    ...Object.fromEntries(
      EXTERNAL_FACTS.flatMap(
        (f): Array<[string, unknown]> => [
          [f, b.facts?.[f] ?? ''],
          [`${f}Refs`, refs.facts[f] ?? []],
        ],
      ),
    ),
    context: paragraphs(b.context, refs.context),
    timeline: withRefs(b.timeline, refs.timeline),
    reception: paragraphs(b.reception, refs.reception),
    adaptations: withRefs(b.adaptations, refs.adaptations),
    sources: b.sources ?? [],
  };
}

/** Ограды перегенерации: прежнее содержимое блока и замечание редактора - данные, не инструкции. */
const regenFences = (regen: StepRegen | null | undefined): Array<readonly [string, string]> =>
  regen
    ? [
        ['CURRENT_BLOCK', JSON.stringify(regen.current ?? null)],
        ['EDITOR_REMARK', regen.remark ?? 'none'],
      ]
    : [];

/**
 * Вход внешнего шага (`tech.md` §2): название, автор, язык оригинала, язык версии (в правилах) и
 * итог шага 3. Ни текста книги, ни досье, ни глоссария, ни списка глав: внешние факты - из знаний
 * модели под проверку источников, а не пересказ текста.
 */
function externalWriteRequest(input: StepPromptInput, system: string): ShapedRequest {
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['ORIGINAL_LANGUAGE', input.originalLanguage || 'unknown'],
    ...input.previous,
    // Перегенерация блока шага 5 (`F07-2b`): прежний блок и замечание редактора - как у шагов 1-4.
    ...regenFences(input.regen),
    ['EXAMPLE', input.example],
  ];
  return shapedRequest(
    STEP_STAGES[input.step],
    STEP_SHAPES[input.step],
    messages(
      system,
      items,
      (n) =>
        `The title of the book is in ${n[0]}, the author in ${n[1]}, the language of the ` +
        `original in ${n[2]}` +
        input.previous.map(([label], i) => `, ${label.toLowerCase()} in ${n[3 + i]}`).join('') +
        (input.regen
          ? `, the current content of the block to rewrite in ${n[3 + input.previous.length]} and the editor remark in ${n[4 + input.previous.length]}`
          : '') +
        `, a sample answer for another book in this language in ${n[items.length - 1]}. ` +
        'The sample shows the form and the level only: never take its content or its addresses.',
      input.redo,
      [],
      // Переделка видит прошлый ответ в форме ответа - со ссылками на источники, иначе ссылки
      // пришлось бы собирать заново и верные утверждения ушли бы без источника.
      externalAnswerOf,
    ),
  );
}

export function stepWriteRequest(input: StepPromptInput): ShapedRequest {
  const system =
    'You write a part of the analysis page of a book for the site: the reader comes for the ' +
    'meaning of the book, not for its plot. This is the text for publication, not a draft.\n' +
    'Main rules (breaking any is a defect):\n' +
    mainRules(input.language, input.step) +
    `\n${qualityBar(input.step)}` +
    `\n${STEP_RULES[input.step]}` +
    (input.regen ? regenRule(input.regen, input.step) : '') +
    (input.bookIsSummaries
      ? '\nThe book is given as the chapter summaries of the dossier: the whole text does not fit. ' +
        'Quote only what you know word for word from this version; a quotation the code cannot ' +
        'find in the chapter is thrown away.'
      : '') +
    (input.step === EXTERNAL_STEP
      ? '\nBefore answering, check: every statement has refs to sources of your list; every ' +
        'source has a full https address; no quotation of the book; no empty template values.'
      : '\nBefore answering, check: every element has its required fields; every chapter number ' +
        'is in the list of chapters; every key is ^[a-z0-9-]{1,60}$ and unique in its list; every ' +
        'quotation is a line of this text word for word; no empty template values.');
  if (input.step === EXTERNAL_STEP) return externalWriteRequest(input, system);
  const items: Array<readonly [string, string]> = [
    ['BOOK_TITLE', input.bookTitle],
    ['AUTHOR', input.author],
    ['CHAPTERS_LIST', input.chapterList],
    ['GLOSSARY', input.glossary],
    ['DOSSIER', input.dossier],
    ['KEYS', input.keys],
    ...input.previous,
    ...regenFences(input.regen),
    ['EXAMPLE', input.example],
    [input.bookIsSummaries ? 'CHAPTER_SUMMARIES' : 'BOOK_TEXT', input.book],
  ];
  const exampleAt = items.length - 2;
  const bookAt = items.length - 1;
  return shapedRequest(
    STEP_STAGES[input.step],
    STEP_SHAPES[input.step],
    messages(
      system,
      items,
      (n) =>
        `The title of the book is in ${n[0]}, the author in ${n[1]}, the chapters of this version ` +
        `(number - title) in ${n[2]}, the glossary in ${n[3]}, the dossier in ${n[4]}, the keys ` +
        `from the analysis of this book in another language in ${n[5]}` +
        input.previous.map(([label], i) => `, ${label.toLowerCase()} in ${n[6 + i]}`).join('') +
        (input.regen
          ? `, the current content of the block to rewrite in ${n[6 + input.previous.length]} and the editor remark in ${n[7 + input.previous.length]}`
          : '') +
        `, a sample answer for another book in this language in ${n[exampleAt]}` +
        ` and the ${input.bookIsSummaries ? 'chapter summaries' : 'text of the book'} in ` +
        `${n[bookAt]}. The sample shows the form and the level only: never take its content.`,
      input.redo,
      [],
    ),
  );
}

/** Что проверяющая сверяет на шаге (`product.md` §3.4). */
const REVIEW_STEP: Record<AnalysisStepNumber, string> = {
  1: 'the card of the work and the characters',
  2: 'the key quotations and the devices of the style',
  3: 'the main idea, the themes, the symbols, the meaning of the title and of the ending',
  4: 'the common misunderstandings, the discussion questions and the FAQ',
  5: 'the genre, the context, the timeline, the reception and the adaptations',
};

interface StepReviewInput {
  step: AnalysisStepNumber;
  language: Language;
  book: string;
  glossary: string;
  /** Итоги прошлых шагов JSON - для `CONTRADICTION`. */
  previous: string;
  answer: StepDraft;
  /** Перегенерация одного блока (`F07-2b`, хвост в): проверяющей - что переписан только он. */
  regenTarget?: string | null;
}

export function stepReviewRequest(input: StepReviewInput): ShapedRequest {
  const external = input.step === EXTERNAL_STEP;
  const system =
    `You check ${REVIEW_STEP[input.step]} of the analysis page of a book written for publication ` +
    'on the site. ' +
    (external
      ? 'The text of the book is not given for this step: compare the answer with the previous ' +
        'steps and with what is reliably known about the book, and list what is wrong. '
      : 'Compare the answer with the book and the previous steps and list what is wrong. ') +
    (input.regenTarget
      ? `Only the block "${input.regenTarget}" was rewritten, the answer holds only it: check ` +
        'only it, and do not remark that the other blocks of the step are missing. '
      : '') +
    'The rules the answer must follow:\n' +
    mainRules(input.language, input.step) +
    `\n${qualityBar(input.step)}` +
    `\n${STEP_RULES[input.step]}` +
    '\nRemark codes:' +
    (external
      ? ''
      : '\n- NOT_IN_TEXT: an interpretation rests on a scene or a detail that is not in the text.') +
    '\n- GENERIC: the text is true for any book (replace the title - nothing changes).' +
    '\n- CONTRADICTION: blocks contradict each other or the previous steps (theme, character, ' +
    'symbol).' +
    '\n- RETELLING: a retelling of the plot instead of an interpretation.' +
    '\n- ONE_SIDED: the disputable is presented as the only right reading.' +
    '\n- STYLE_POOR: clichés, empty praise, officialese, calques.' +
    (input.step === READER_STEP
      ? '\n- FAQ_WEAK: a FAQ question is not like a search query of this language, or the answer ' +
        'is not direct in the first sentence.' +
        '\n- MYTH_INVENTED: a "misunderstanding" looks invented only to be refuted.'
      : '') +
    (input.step === EXTERNAL_STEP
      ? '\n- EXTERNAL_DOUBT: an external statement is doubtful (a date, a name, the fact of an ' +
        'adaptation): the code removes the statement when the doubt stays after the redo. where: ' +
        'the path of the statement itself - facts.genre, context.1 (the second paragraph; ' +
        'paragraphs are separated by an empty line), reception.0, timeline.2, adaptations.0.'
      : '') +
    '\nThe import form, the chapter numbers, whether quotations are word for word, the language ' +
    'and service phrases are checked by code: do not remark on them. where: the field path first ' +
    '(themes.guilt.interpretation, characters.anna.description, mainIdea), then a short ' +
    'fragment; note: what to fix, in English. verdict "ok" with an empty list when there is ' +
    'nothing to fix.';
  return shapedRequest(
    ANALYSIS_REVIEW_STAGE,
    ANALYSIS_REVIEW_SHAPE,
    messages(
      system,
      [
        ['BOOK', input.book],
        ['GLOSSARY', input.glossary],
        ['PREVIOUS_STEPS', input.previous],
        ['ANSWER', JSON.stringify(input.answer.blocks)],
      ],
      (n) =>
        `The book is in ${n[0]}, the glossary in ${n[1]}, the previous steps in ${n[2]} and the ` +
        `answer to check in ${n[3]}.`,
      null,
      [],
    ),
  );
}
