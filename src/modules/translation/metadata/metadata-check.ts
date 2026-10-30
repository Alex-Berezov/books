import { Language } from '@prisma/client';
import { sanitizeRichHtml } from '../../../shared/sanitize/rich-html';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import {
  VERSION_AUTHOR_MAX_LENGTH,
  VERSION_TITLE_MIN_LENGTH,
} from '../../../shared/constants/validation';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { assembleChapter, ChapterBlock, ChapterLayout } from '../chapter-blocks';
import { LANGUAGE_NAMES } from '../dossier/dossier.prompts';
import { detectLanguage, FUNCTION_WORDS, wordsOf } from '../check/language-detector';
import { CHECK_FLAG_REASONS } from '../check/check.constants';
import { checkMechanical, NameEntry, normalized } from '../check/mechanical-check';
import { blockText, cleanedBlockErrors, translateBlockErrors } from '../translate/translate.format';
import { MetadataAnswer } from './metadata.prompts';

/** Принятый ответ этапа: поля версии на целевом языке, описание - собранный очищенный HTML. */
export interface MetadataResult {
  title: string;
  author: string;
  /**
   * Имя автора - форма записи глоссария; `false` - модель дала свою (решение арбитра `F05 | F05-6`);
   * `null` - автора нет ни у исходника, ни в ответе, сверять нечего (решение арбитра `F05 | F05-17`);
   * имя, которое модель дала исходнику без автора, - `false`: его надо проверить.
   */
  authorFromGlossary: boolean | null;
  description: string;
  chapterTitles: Array<{ number: number; title: string }>;
}

export interface MetadataSource {
  sourceLanguage: Language;
  targetLanguage: Language;
  title: string;
  author: string;
  descriptionLayout: Pick<ChapterLayout, 'blocks' | 'parts'>;
  chapterTitles: ReadonlyArray<{ number: number; title: string }>;
  /** Записи глоссария входа этапа. */
  glossary: readonly NameEntry[];
}

/**
 * Ошибки формы сверх схемы - уходят модели замечанием того же вызова (`callShaped`): блоки
 * описания и номера глав ровно как у исходника, блок описания не пустеет после белого списка
 * разметки (как у куска, `cleanedBlockErrors`).
 */
export function metadataFormErrors(
  value: unknown,
  descriptionBlocks: ReadonlyArray<Pick<ChapterBlock, 'n' | 'kind' | 'html'>>,
  chapterNumbers: readonly number[],
): string[] {
  const answer = value as MetadataAnswer;
  const blocks = { blocks: answer.description };
  const numbers = translateBlockErrors(
    blocks,
    descriptionBlocks.map((b) => b.n),
  );
  const errors = (
    numbers.length > 0
      ? numbers
      : cleanedBlockErrors(blocks, new Map(descriptionBlocks.map((b) => [b.n, b])))
  ).map((e) => e.replace('$.blocks', '$.description'));
  const wanted = new Set(chapterNumbers);
  const seen = new Set<number>();
  for (const c of answer.chapterTitles) {
    if (!wanted.has(c.number))
      errors.push(`$.chapterTitles: chapter ${c.number} is not in the book`);
    else if (seen.has(c.number)) errors.push(`$.chapterTitles: chapter ${c.number} is repeated`);
    seen.add(c.number);
  }
  const missing = chapterNumbers.filter((n) => !seen.has(n));
  if (missing.length > 0) errors.push(`$.chapterTitles: missing chapters ${missing.join(', ')}`);
  return errors;
}

/**
 * Из механики куска описание берёт только язык (решение арбитра `F05 | F05-6`: детектор кодом,
 * санитайз и длины ручного пути): коридор длины, обрыв и служебные фразы на коротком описании
 * дали бы ложный `failed` языка, книга которого уже переведена.
 */
const DESCRIPTION_LANGUAGE_FAILURES: ReadonlySet<string> = new Set([
  CHECK_FLAG_REASONS.LANGUAGE_MISMATCH,
  CHECK_FLAG_REASONS.FOREIGN_SHARE,
  CHECK_FLAG_REASONS.FOREIGN_BLOCK,
]);

/** Текст без тегов: название, автор и названия глав - строки, а не HTML. */
export function plainLine(text: string): string {
  return richHtmlText(sanitizeRichHtml(text)).replace(/\s+/g, ' ').trim();
}

/** Запись глоссария об авторе: по написанию исходника без регистра и диакритики. */
function authorEntry(source: MetadataSource): NameEntry | undefined {
  const author = normalized(plainLine(source.author));
  if (author === '') return undefined;
  return source.glossary.find((e) => normalized(e.source.trim()) === author);
}

/**
 * Проверки ответа кодом (`F05-6`, шаг 4; решение арбитра `F05 | F05-6`: детектор языка, санитайз
 * и длины ручного пути, смысл моделью - нет). Детектор на коротком «не уверен» - это пройдено.
 * Возвращает принятые поля или замечания на повтор этапа.
 */
export function checkMetadata(
  source: MetadataSource,
  answer: MetadataAnswer,
): { ok: true; result: MetadataResult } | { ok: false; remarks: string[] } {
  const remarks: string[] = [];
  const target = source.targetLanguage;
  const exclude = new Set(
    source.glossary
      .flatMap((e) => [...wordsOf(e.target), ...(e.keepOriginal ? wordsOf(e.source) : [])])
      .filter((w) => !FUNCTION_WORDS.has(w)),
  );
  const foreign = (text: string): Language | null => {
    const found = detectLanguage(text, exclude).language;
    return found !== null && found !== target ? found : null;
  };

  const title = plainLine(answer.title);
  if (title.length < VERSION_TITLE_MIN_LENGTH) {
    remarks.push(`The title must be at least ${VERSION_TITLE_MIN_LENGTH} characters long.`);
  } else {
    const found = foreign(title);
    if (found) {
      remarks.push(
        `The title is not in ${LANGUAGE_NAMES[target]}: it reads as ${LANGUAGE_NAMES[found]}.`,
      );
    }
  }

  const author = plainLine(answer.author);
  const sourceAuthor = plainLine(source.author);
  const entry = authorEntry(source);
  if (author.length > VERSION_AUTHOR_MAX_LENGTH) {
    remarks.push(`The author name must be at most ${VERSION_AUTHOR_MAX_LENGTH} characters long.`);
  } else if (sourceAuthor !== '' && author === '') {
    remarks.push('The author name came back empty.');
  } else if (entry && normalized(author) !== normalized(entry.target.trim())) {
    remarks.push(`The author name must be exactly the glossary form: ${entry.target}.`);
  }

  const sourceBlocks = source.descriptionLayout.blocks
    .filter((b) => b.translatable)
    .map((b) => ({ n: b.n, html: b.html }));
  const kinds = new Map(source.descriptionLayout.blocks.map((b) => [b.n, b]));
  const blocks = answer.description.map((b) => ({
    n: b.n,
    text: blockText(kinds.get(b.n) ?? { kind: 'p' as const, html: '' }, b.text),
  }));
  if (sourceBlocks.length > 0) {
    const mechanical = checkMechanical({
      sourceLanguage: source.sourceLanguage,
      targetLanguage: target,
      source: sourceBlocks,
      translated: blocks,
      glossary: source.glossary,
    });
    remarks.push(
      ...mechanical.failures
        .filter((f) => DESCRIPTION_LANGUAGE_FAILURES.has(f.code))
        .map((f) => `Description: ${f.remark}`),
    );
  }
  const description = sanitizeRichHtml(
    assembleChapter(source.descriptionLayout, new Map(blocks.map((b) => [b.n, b.text]))),
  );
  if (description.length > RICH_HTML_MAX_LENGTH.text) {
    remarks.push(
      `The description is ${description.length} characters long, the limit is ` +
        `${RICH_HTML_MAX_LENGTH.text}. Translate it closer to the source length.`,
    );
  }

  const byNumber = new Map(answer.chapterTitles.map((c) => [c.number, plainLine(c.title)]));
  const chapterTitles = source.chapterTitles.map((c) => ({
    number: c.number,
    title: byNumber.get(c.number) ?? '',
  }));
  const empty = chapterTitles
    .filter((c, i) => c.title === '' && plainLine(source.chapterTitles[i].title) !== '')
    .map((c) => c.number);
  if (empty.length > 0) {
    remarks.push(`Chapter titles ${empty.join(', ')} came back empty. Translate every title.`);
  }
  const foreignTitles = chapterTitles.filter((c) => foreign(c.title)).map((c) => c.number);
  if (foreignTitles.length > 0) {
    remarks.push(
      `Chapter titles ${foreignTitles.join(', ')} are not in ${LANGUAGE_NAMES[target]}. ` +
        'Translate them; keep in the original only what the glossary says to keep.',
    );
  }

  if (remarks.length > 0) return { ok: false, remarks };
  return {
    ok: true,
    result: {
      title,
      author,
      authorFromGlossary: sourceAuthor === '' && author === '' ? null : entry !== undefined,
      description,
      chapterTitles,
    },
  };
}
