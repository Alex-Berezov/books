import { Language } from '@prisma/client';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { ContestedWindow } from '../chunking/chapter-chunks';
import { LANGUAGE_NAMES, shapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenced, remarksPart } from '../fenced-data';
import { SPLIT_SHAPE, TRANSLATE_SHAPE } from './translate.format';

/**
 * Промпты этапов `split` и `translate` (`F05-3`, шаги 1-2; `tech.md` §2, этапы 3-4). Текст книги
 * идёт только в сообщения вызова и никуда не пишется, кроме перевода куска; в промптах он и всё,
 * что из него собрано (досье, глоссарий, пересказ главы), - данными в ограде `fenced` (`F05-14`).
 */

export function splitMessages(window: ContestedWindow): LlmChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You choose where to cut a book chapter into translation pieces. Each candidate is a ' +
        'block that would start the next piece, with its first words. Choose the candidate ' +
        'where a scene or a train of thought ends; never cut inside a dialogue exchange. ' +
        'Answer with the block number only, as boundaryBlock. ' +
        FENCE_RULE,
    },
    {
      role: 'user',
      content: fenced(
        'CANDIDATES',
        window.candidates.map((c) => `[${c.block}] (${c.words} words before) ${c.head}`).join('\n'),
      ),
    },
  ];
}

export const splitRequest = (window: ContestedWindow) =>
  shapedRequest('split', SPLIT_SHAPE, splitMessages(window));

/** Стабильная часть досье для перевода: голос, рассказчик, обстановка, главные персонажи. */
export interface TranslateContext {
  voice: unknown;
  narration: unknown;
  setting: unknown;
  mainCharacters: unknown[];
}

export interface TranslateInput {
  sourceLanguage: Language;
  targetLanguage: Language;
  context: TranslateContext;
  /** Записи глоссария, встреченные в куске и соседних, и записи главных персонажей. */
  glossary: { entries: unknown[]; address: unknown[]; phrases: unknown[] };
  chapterNumber: number;
  chapterSummary: string | null;
  /** Конец предыдущего переведённого куска той же модели; пусто у первого куска. */
  previousTail: string | null;
  blocks: Array<{ n: number; html: string }>;
  /**
   * Замечания проверяющего к прошлому переводу куска (`F05-5`, повтор после провала проверки;
   * решение арбитра `F05 | F05-5`); пусто - первый перевод.
   */
  reviewerRemarks?: readonly string[];
}

/**
 * Запрос перевода куска. Системное сообщение одинаково для всех кусков книги: инструкции, правило
 * ограды и досье - в ограде, после правила; изменчивая часть (глоссарий, глава, хвост, замечания,
 * блоки) - только в пользовательском. Поставщик модели перевода кэширует лишь системное
 * сообщение: досье вне него теряет кэш (живое сравнение 29.10.2026). Строку-инструкцию из книги в
 * досье держат ограда и `FENCE_RULE` (`tech.md` §2, «Контекст на вызов»; решение арбитра
 * `F05 | F05-14`, кэш).
 */
export function translateMessages(input: TranslateInput): LlmChatMessage[] {
  const target = `${LANGUAGE_NAMES[input.targetLanguage]} (language code "${input.targetLanguage}")`;
  const dossier = JSON.stringify(input.context);
  const glossary = JSON.stringify(input.glossary);
  const blocks = input.blocks.map((b) => `[${b.n}] ${b.html}`).join('\n');
  const others = [dossier, glossary, input.chapterSummary ?? '', input.previousTail ?? '', blocks];
  return [
    {
      role: 'system',
      content:
        `You are a literary translator from ${LANGUAGE_NAMES[input.sourceLanguage]} into ${target}. ` +
        'Translate the whole meaning of every block, keep the voice of the author: pace, sentence ' +
        'length, lexicon, irony, forms of address. Names, places and terms follow the glossary ' +
        'exactly. Keep the inline markup of a block (<em>, <strong>, <a>, <br> and the like) ' +
        'around the same words; never add block tags. No comments, no notes to the reader, no ' +
        'text outside the blocks. Return every block with its number. glossaryFindings: names, ' +
        'places and terms of this piece that are missing from the glossary, with your spelling. ' +
        FENCE_RULE +
        `\n\nBook dossier:\n${fenced('DOSSIER', dossier)}`,
    },
    {
      role: 'user',
      content:
        `Glossary:\n${fenced('GLOSSARY', glossary)}\n\n` +
        `Reader chapter ${input.chapterNumber}` +
        (input.chapterSummary
          ? `, summary:\n${fenced('CHAPTER_SUMMARY', input.chapterSummary)}`
          : '') +
        '\n\n' +
        (input.previousTail
          ? 'End of the previous translated piece:\n' +
            `${fenced('PREVIOUS_TAIL', input.previousTail)}\n\n`
          : '') +
        (input.reviewerRemarks && input.reviewerRemarks.length > 0
          ? remarksPart(
              'Your previous translation of this piece failed the check. Reviewer remarks:',
              'your task is a translation of the blocks without these defects.',
              input.reviewerRemarks,
              others,
            )
          : '') +
        'Blocks to translate, as "[n] text":\n' +
        fenced('BLOCKS', blocks),
    },
  ];
}

export const translateRequest = (input: TranslateInput) =>
  shapedRequest('translation', TRANSLATE_SHAPE, translateMessages(input));
