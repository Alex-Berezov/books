import { Language } from '@prisma/client';
import { ChapterBlock } from '../chapter-blocks';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { Shape } from '../dossier/dossier.format';
import { LANGUAGE_NAMES, shapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenced, remarksPart } from '../fenced-data';
import { TranslatedBlock } from '../translate/translate.format';

/**
 * Этап `metadata` (`F05-6`, шаг 4; `tech.md` §2, этап 8): название, описание, автор и названия
 * глав версии на целевом языке. Описание - блоками, как глава (`splitChapter`): модель не видит
 * сырой HTML, код собирает его обратно тем же путём.
 */
export const METADATA_SHAPE: Shape = {
  object: {
    title: 'string',
    author: 'string',
    description: { array: { object: { n: 'int', text: 'string' } } },
    chapterTitles: { array: { object: { number: 'int', title: 'string' } } },
  },
};

export interface MetadataAnswer {
  title: string;
  author: string;
  description: TranslatedBlock[];
  chapterTitles: Array<{ number: number; title: string }>;
}

export interface MetadataInput {
  sourceLanguage: Language;
  targetLanguage: Language;
  title: string;
  author: string;
  /** Переводимые блоки описания; вид - для белого списка ответа (`blockText`), в промпт не идёт. */
  description: Array<Pick<ChapterBlock, 'n' | 'kind' | 'html'>>;
  /** Названия всех глав исходника по номерам, пустые - тоже: номер ответа сверяется кодом. */
  chapterTitles: Array<{ number: number; title: string }>;
  /** Записи глоссария, встреченные в названии, авторе, описании и названиях глав. */
  glossary: { entries: unknown[]; address: unknown[]; phrases: unknown[] };
  /** Замечания проверки прошлого ответа; пусто - первый вызов. */
  remarks?: readonly string[];
}

export function metadataMessages(input: MetadataInput): LlmChatMessage[] {
  const target = `${LANGUAGE_NAMES[input.targetLanguage]} (language code "${input.targetLanguage}")`;
  const glossary = JSON.stringify(input.glossary);
  const data =
    `Title: ${input.title}\n` +
    `Author: ${input.author}\n\n` +
    'Description blocks, as "[n] text":\n' +
    input.description.map((b) => `[${b.n}] ${b.html}`).join('\n') +
    '\n\nChapter titles, as "[number] title":\n' +
    input.chapterTitles.map((c) => `[${c.number}] ${c.title}`).join('\n');
  return [
    {
      role: 'system',
      content:
        `You translate the catalogue fields of a book from ${LANGUAGE_NAMES[input.sourceLanguage]} ` +
        `into ${target}: the title, the author name, the description and the chapter titles. ` +
        'Names and terms follow the glossary exactly; the author name too, when the glossary has ' +
        'it. Otherwise give the author name in the form accepted in the target language, or a ' +
        'transliteration; never another person. Translate the title as it reads in the text; never ' +
        'replace it with a known published title that is not a translation of it. Keep the inline ' +
        'markup of a description block around the same words; never add block tags. Return every ' +
        'description block with its number and every chapter title with its number; an empty ' +
        'source title stays empty. No comments, no text outside the fields. ' +
        FENCE_RULE,
    },
    {
      role: 'user',
      content:
        `Glossary:\n${fenced('GLOSSARY', glossary)}\n\n` +
        (input.remarks && input.remarks.length > 0
          ? remarksPart(
              'Your previous answer failed the check. Remarks:',
              'your task is an answer without these defects.',
              input.remarks,
              [glossary, data],
            )
          : '') +
        fenced('DATA', data),
    },
  ];
}

export const metadataRequest = (input: MetadataInput) =>
  shapedRequest('metadata', METADATA_SHAPE, metadataMessages(input));
