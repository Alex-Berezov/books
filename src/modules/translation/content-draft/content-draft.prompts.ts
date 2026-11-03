import { Language } from '@prisma/client';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { LANGUAGE_NAMES, shapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenceAll, fencedOwn } from '../fenced-data';
import { ANALYSIS_DRAFT_SHAPE } from './content-draft.analysis';

/**
 * Промпт заготовки Analysis (`F05-11`). Текст книги, досье и сохранённый анализ идут данными
 * между границами `fenced`, а не инструкцией; в базу пишется только ответ. Промпты пошаговых
 * заготовок Summary `F05-10` сняты в `F06-3` (решение арбитра `F06 | F06-3`, А3).
 */

function languageRule(language: Language): string {
  return (
    `Write in ${LANGUAGE_NAMES[language]} (language code "${language}") only. Names of ` +
    'characters, places and objects exactly as in the glossary (or the dossier when there is no ' +
    'glossary) and as in the text.'
  );
}

/**
 * Название версии - данные, не инструкция: у черновика перевода его пишет модель этапа `metadata`.
 * Системное сообщение называет его блок, поэтому имя ограды - только по самому названию, а
 * остальные блоки обходят его через `outside`: системное сообщение одинаково у всех разделов
 * версии, подделка `<<<BOOK_TITLE` в главах остаётся внутри своей ограды (решение арбитра
 * `T146 | LEGACY-481`, круг 2).
 */
function bookTitleFence(title: string): { name: string; block: string } {
  return fencedOwn('BOOK_TITLE', title);
}

export interface AnalysisPromptInput {
  bookTitle: string;
  language: Language;
  dossier: unknown;
  glossary: unknown;
  /** Сохранённые `facts`, `characters`, `keyQuotes`, `style` версии: модель их не повторяет. */
  stored: unknown;
  /** Все главы версии: `[READER CHAPTER n]` и абзацы. */
  chaptersText: string;
}

/**
 * Заготовка Analysis (`F05-11`): только факты по тексту - герои, цитаты, приёмы, место, время,
 * рассказчик, композиция. Толкований и внешних фактов модель не пишет (`product.md` §5.3);
 * слияние с сохранённым и проверку цитат делает код (решение арбитра `F05 | F05-11`, Р3).
 */
export function analysisDraftMessages(input: AnalysisPromptInput): LlmChatMessage[] {
  const dossier = JSON.stringify(input.dossier);
  const glossary = input.glossary === null ? null : JSON.stringify(input.glossary);
  // Системное сообщение называет блоки по имени - имя по всем данным вызова (`F05-14`).
  const bookTitle = bookTitleFence(input.bookTitle);
  const [dossierBlock, glossaryBlock, saved, chapters] = fenceAll(
    [
      ['DOSSIER', dossier],
      ['GLOSSARY', glossary ?? ''],
      ['SAVED', JSON.stringify(input.stored)],
      ['CHAPTERS', input.chaptersText],
    ],
    [input.bookTitle],
  );
  return [
    {
      role: 'system',
      content:
        'You prepare a draft of the facts for the analysis page of the book whose title is in ' +
        `the ${bookTitle.name} block. ` +
        'Write only what is in the text of the book: no history of writing, no criticism, no ' +
        'adaptations, no years of work, no sources, no interpretation and no evaluation ("symbolizes", ' +
        '"shows", "brilliant").\n' +
        languageRule(input.language) +
        `\nThe editor has already saved part of the analysis (${saved.name}). Do not repeat what is ` +
        'there: return only new characters, quotes and devices, and values for fields that are ' +
        `empty in ${saved.name}. A saved character or device may be returned again only to fill its ` +
        'empty fields - with the same key or name.' +
        '\nRules:' +
        '\n1. facts: settingPlace, settingTime, narrator (who tells the story and in which ' +
        `person), structure (parts, chapters, frame) - short phrases; "" when ${saved.name} has the ` +
        'value or the text does not say.' +
        '\n2. characters: the main and important secondary characters, at most ' +
        `${BOOK_ANALYSIS_LIMITS.characters} in all with ${saved.name}. key - lowercase latin letters, ` +
        'digits and "-", the key of the dossier when it has one. name - by the glossary. role - ' +
        'main, secondary or minor. arcFrom and arcTo - who the character is at the start and at ' +
        'the end, a short phrase each, or "" for both. quote - a recognizable line of the ' +
        'character copied word for word from the chapter quoteChapter, or "" and 0. relations - ' +
        'to main or secondary characters by key, label - who they are to each other; never to ' +
        'the character itself.' +
        ` At most ${BOOK_ANALYSIS_LIMITS.relations} relations per character; a quote at most ` +
        `${BOOK_ANALYSIS_LIMITS.quote} characters.` +
        `\n3. keyQuotes: 10-${BOOK_ANALYSIS_LIMITS.keyQuotes} memorable lines with ${saved.name} ` +
        'included, each copied word for word from the chapter given in chapter (the number ' +
        `after READER CHAPTER), at most ${BOOK_ANALYSIS_LIMITS.quote} characters; speakerKey - ` +
        'the key of the speaking character, "" for the narrator or the author.' +
        `\n4. style: at most ${BOOK_ANALYSIS_LIMITS.style} devices of the author with ${saved.name}: ` +
        'device - the name, explanation - how it appears in this text (never empty), example - a ' +
        'passage copied word for word from the chapter exampleChapter, at most ' +
        `${BOOK_ANALYSIS_LIMITS.quote} characters, or "" and 0.` +
        '\nA quotation is copied exactly, with the punctuation of the text; never retell, ' +
        'shorten inside or join two places. A quotation that is not word for word is thrown ' +
        'away.\n' +
        FENCE_RULE,
    },
    {
      role: 'user',
      content:
        dossierBlock.block +
        '\n\n' +
        (glossary === null ? '' : glossaryBlock.block + '\n\n') +
        saved.block +
        '\n\n' +
        `${bookTitle.block}\n\n` +
        chapters.block,
    },
  ];
}

export const analysisDraftRequest = (input: AnalysisPromptInput) =>
  shapedRequest('analysis_draft', ANALYSIS_DRAFT_SHAPE, analysisDraftMessages(input));
