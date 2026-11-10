import { Language } from '@prisma/client';
import { detectLanguage, FOREIGN_WINDOW_WORDS, wordsOf } from '../check/language-detector';
import {
  formFound,
  glossaryExclusions,
  hasPhrase,
  NameEntry,
  normalized,
} from '../check/mechanical-check';
import { LANGUAGE_NAMES } from '../dossier/dossier.prompts';
import { divergentEntries, wordsIn } from '../final-check/final-check-code';
import { ChapterIndex, findVerbatim, paragraphsOf } from './quote-check';

/**
 * Код-проверки чистовика, общие для пересказа (`F06`) и анализа (`F07`):
 * `features/F06-summary-autofill/product.md` §3. Чистые функции: вход - текст и то, с чем его
 * сверяют, выход - замечания. Замечание - вопрос автору на переделке и флаг редактору, текст
 * не выкидывается (U5).
 */

/**
 * Коды замечаний пересказа - §3 `product.md` `F06`: код ставит первые семь, проверяющая модель -
 * кроме длины и строя. Перечень ответа хода пересказа (`SummaryWriteRemarkDto`, решение арбитра
 * `F07 | F07-1a`, Р13): коды анализа в него не попадают.
 */
export const SUMMARY_REMARK_CODES = [
  'LENGTH_OUT',
  'STRUCTURE_BROKEN',
  'LANGUAGE_MIXED',
  'QUOTE_NOT_VERBATIM',
  'NAME_MISMATCH',
  'JUNK',
  'DUPLICATE_TEXT',
  'FACT_UNSUPPORTED',
  'EVENT_MISSING',
  'EXTERNAL_FACT',
  'ORDER_BROKEN',
  'STYLE_POOR',
] as const;

/**
 * Коды, которые ставит проверяющая модель пересказа (§3): длину, строй, язык, цитаты и мусор ставит
 * код. У анализа `F07` свой набор (решение арбитра `F07 | F07-1`, В2).
 */
export const SUMMARY_REVIEW_REMARK_CODES = [
  'NAME_MISMATCH',
  'FACT_UNSUPPORTED',
  'EVENT_MISSING',
  'EXTERNAL_FACT',
  'ORDER_BROKEN',
  'STYLE_POOR',
] as const satisfies readonly DraftRemarkCode[];

/**
 * Все коды чистовика: коды пересказа и коды анализа `F07` (`features/F07-analysis-autofill/product.md`
 * §3.2, §3.4; решение арбитра `F07 | F07-1`, В2): код - `IMPORT_INVALID`, `CHAPTER_UNKNOWN`,
 * `LIMIT_OUT`, `CORE_MISSING`, проверяющая - `NOT_IN_TEXT` … `ONE_SIDED` и общий `STYLE_POOR`.
 */
export const DRAFT_REMARK_CODES = [
  ...SUMMARY_REMARK_CODES,
  'IMPORT_INVALID',
  'CHAPTER_UNKNOWN',
  'LIMIT_OUT',
  'CORE_MISSING',
  'NOT_IN_TEXT',
  'GENERIC',
  'CONTRADICTION',
  'RETELLING',
  'ONE_SIDED',
  // Шаги 4-5 хода анализа (`F07-2a`, `product.md` §3.3-§3.4).
  'FAQ_WEAK',
  'MYTH_INVENTED',
  'EXTERNAL_DOUBT',
  'EXTERNAL_CHECK',
  'SOURCE_UNREACHABLE',
  'SOURCE_UNRELATED',
  'SOURCE_UNVERIFIED',
] as const;
export type DraftRemarkCode = (typeof DRAFT_REMARK_CODES)[number];

/**
 * Коды, которые ставит ход анализа `F07` (решение арбитра `F07 | F07-1a`, А4): общие код-проверки
 * текста (язык, имена, мусор), проверяющая анализа (`ANALYSIS_REVIEW_CODES` с общим `STYLE_POOR`)
 * и коды анализа. Перечень ответа хода анализа (`AnalysisWriteRemarkDto`); кодов пересказа, которых
 * ход не ставит, в нём нет. Полноту держит `analysis-checks.spec.ts`.
 */
export const ANALYSIS_REMARK_CODES = [
  'LANGUAGE_MIXED',
  'NAME_MISMATCH',
  'JUNK',
  'STYLE_POOR',
  'IMPORT_INVALID',
  'CHAPTER_UNKNOWN',
  'LIMIT_OUT',
  'QUOTE_NOT_VERBATIM',
  'CORE_MISSING',
  'NOT_IN_TEXT',
  'GENERIC',
  'CONTRADICTION',
  'RETELLING',
  'ONE_SIDED',
  'FAQ_WEAK',
  'MYTH_INVENTED',
  'EXTERNAL_DOUBT',
  'EXTERNAL_CHECK',
  'SOURCE_UNREACHABLE',
  'SOURCE_UNRELATED',
  'SOURCE_UNVERIFIED',
] as const satisfies readonly DraftRemarkCode[];
export type AnalysisRemarkCode = (typeof ANALYSIS_REMARK_CODES)[number];

/** Замечание к тексту (`tech.md` §2): место - короткий фрагмент текста или имя части. */
export interface DraftRemark {
  code: DraftRemarkCode;
  where: string;
  /** Объяснение автору на переделке - по-английски, как промпт. */
  note: string;
  by: 'code' | 'model';
}

/** Цитата - текст в кавычках от стольких слов; короче - название или прозвище (§3). */
export const QUOTE_MIN_WORDS = 5;
/** Дубль - совпадение стольких слов подряд (§2.2, §2.3, `F04` §6 п.5). */
const DUPLICATE_RUN_WORDS = 12;
/** Длина фрагмента в поле `where`. */
const WHERE_MAX = 80;

export const codeRemark = (code: DraftRemarkCode, where: string, note: string): DraftRemark => ({
  code,
  where: where.length > WHERE_MAX ? `${where.slice(0, WHERE_MAX - 1)}…` : where,
  note,
  by: 'code',
});

/**
 * Слово - буквы и цифры с апострофом и дефисом внутри. Одно правило на объём (`wordCount`)
 * и серии `DUPLICATE_TEXT` (`runWords`): «12 слов подряд» и «N слов» считаются одинаково.
 */
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Слова текста для счёта объёма. */
export function wordCount(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/**
 * Текст в парных кавычках («», “”, „“, "") внутри одной строки - кандидаты в цитаты. Пара через
 * перевод строки не считается: одиночная кавычка («5"», незакрытая реплика) иначе склеила бы
 * в «цитату» текст до следующей кавычки в другом абзаце.
 */
function quotedFragments(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/«([^«»\n]+)»|“([^“”\n]+)”|„([^„“”\n]+)[“”]|"([^"\n]+)"/gu)) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (inner !== undefined) found.push(inner.trim());
  }
  return found;
}

/**
 * `QUOTE_NOT_VERBATIM` (§3): текст в кавычках от `QUOTE_MIN_WORDS` слов не нашёлся дословно
 * ни в одном абзаце `chapters` (у раздела - главы раздела, у полного и «Очень кратко» - вся
 * версия); номер главы не нужен. Отдаёт и цитаты, прошедшие сверку, - их не считает `DUPLICATE_TEXT`.
 * Пересказ сверяет по `findVerbatim` с порогом `QUOTE_MIN_WORDS`; толкования анализа (`F07-5`)
 * передают свой порог и сверку `matches` (`quotedInText` из `quote-check.ts`) - `chapters` тогда
 * не читается.
 */
export function checkQuotes(
  text: string,
  chapters: ChapterIndex,
  options: { minWords?: number; matches?: (quote: string) => boolean } = {},
): { remarks: DraftRemark[]; verbatim: string[] } {
  const minWords = options.minWords ?? QUOTE_MIN_WORDS;
  const paragraphs = options.matches ? [] : [...chapters.values()].flat();
  const found = options.matches ?? ((quote: string) => findVerbatim(quote, paragraphs) !== null);
  const remarks: DraftRemark[] = [];
  const verbatim: string[] = [];
  for (const quote of quotedFragments(text)) {
    if (wordCount(quote) < minWords) continue;
    if (found(quote)) {
      verbatim.push(quote);
      continue;
    }
    remarks.push(
      codeRemark(
        'QUOTE_NOT_VERBATIM',
        quote,
        'This quotation is not word for word in the book text. Quote the book exactly or retell ' +
          'it in your own words without quotation marks.',
      ),
    );
  }
  return { remarks, verbatim };
}

const runWords = (text: string): string[] => normalized(text).match(WORD) ?? [];

/**
 * `DUPLICATE_TEXT` (§2.2, §2.3): `DUPLICATE_RUN_WORDS` слов подряд совпадают с одним из `others`.
 * Цитаты из `verbatim` (прошли `QUOTE_NOT_VERBATIM`) вырезаются из обоих текстов до сравнения.
 */
export function checkDuplicate(
  text: string,
  others: ReadonlyArray<{ label: string; text: string }>,
  verbatim: readonly string[] = [],
): DraftRemark[] {
  const strip = (t: string) => verbatim.reduce((acc, q) => acc.split(q).join(' '), t);
  const words = runWords(strip(text));
  if (words.length < DUPLICATE_RUN_WORDS) return [];
  const runs = new Set<string>();
  for (let i = 0; i + DUPLICATE_RUN_WORDS <= words.length; i++) {
    runs.add(words.slice(i, i + DUPLICATE_RUN_WORDS).join(' '));
  }
  return others.flatMap((other) => {
    const theirs = runWords(strip(other.text));
    for (let i = 0; i + DUPLICATE_RUN_WORDS <= theirs.length; i++) {
      if (!runs.has(theirs.slice(i, i + DUPLICATE_RUN_WORDS).join(' '))) continue;
      return [
        codeRemark(
          'DUPLICATE_TEXT',
          other.label,
          `${DUPLICATE_RUN_WORDS} or more words in a row repeat ${other.label} word for word. ` +
            'Say it in other words.',
        ),
      ];
    }
    return [];
  });
}

/**
 * Служебные фразы модели пяти языков по группам (§2 «без служебного мусора», «без обращений
 * к читателю», «без предупреждений о спойлерах»). Сравнение - в форме `normalized` (нижний
 * регистр без диакритики, «й» - «и»), поэтому список приводится к ней же при сборке.
 */
export const JUNK_PHRASES: readonly string[] = [
  // Начало ответа модели.
  'here is the summary',
  "here's the summary",
  'here is a summary',
  'here is the analysis',
  'конечно, вот',
  'вот пересказ',
  'вот краткий пересказ',
  'aquí está el resumen',
  'por supuesto, aquí',
  'voici le résumé',
  'bien sûr, voici',
  'aqui está o resumo',
  'claro, aqui',
  // Обращение к читателю.
  'in this chapter we',
  'в этой главе мы',
  'en este capítulo veremos',
  'en este capítulo descubrimos',
  'dans ce chapitre, nous',
  'dans ce chapitre nous',
  'neste capítulo vamos',
  'neste capítulo veremos',
  // Предупреждение о спойлерах.
  'spoiler alert',
  'spoiler warning',
  'внимание, спойлер',
  'осторожно, спойлер',
  'alerta de spoiler',
  'atención, spoiler',
  'alerte spoiler',
  'attention, spoiler',
  'attention spoiler',
  'aviso de spoiler',
  // Пометки модели.
  'as an ai',
].map(normalized);

/**
 * Разметка Markdown: заголовок, ограда кода, список (две строки подряд с маркером - одиночная
 * строка «- реплика» или «1. » это диалог или текст), жирный, ссылка.
 */
const MARKDOWN =
  /(^|\n)[ \t]{0,3}(#{1,6}[ \t]|```)|(^|\n)[ \t]{0,3}([-*+]|\d+\.)[ \t][^\n]*\n[ \t]{0,3}([-*+]|\d+\.)[ \t]|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/u;
/**
 * Конец законченного текста для публикации: точка, «!», «?», «…» и закрывающие кавычки или
 * скобки. Строже `SENTENCE_END` перевода: кусок перевода вправе кончаться тире или двоеточием
 * перед репликой, пересказ - нет (обрыв лимитом на «—» или «:»).
 */
const TEXT_END = /[.!?…]["»”’)\]]*\s*$/u;
/**
 * Строка подзаголовка `## ` с текстом (§2.2) в любом месте блока - одно правило на строй
 * (`blocksOf`, `isSubheading`), Markdown (`checkJunk`) и HTML хода (`F06-2`); решение арбитра
 * `F06 | F06-1`, круг 3.
 */
const SUBHEADING_LINE = /^##[ \t]+\S[^\n]*$/gmu;

/** Тот же `SUBHEADING_LINE` на целый блок: без `g` (нет `lastIndex`) и без `m` (весь блок - одна строка). */
const SUBHEADING_BLOCK = new RegExp(SUBHEADING_LINE.source, 'u');

/** Блок - подзаголовок `## ` с текстом. */
export const isSubheading = (block: string): boolean => SUBHEADING_BLOCK.test(block);

/** Абзацы текста, где каждая строка подзаголовка - свой блок, даже без пустой строки рядом. */
export function blocksOf(text: string): string[] {
  return paragraphsOf(text.replace(SUBHEADING_LINE, '\n$&\n'));
}

/**
 * `JUNK` (§3): служебная фраза модели, Markdown в простом поле, обрыв на полуслове.
 * `subheadings` - поле допускает подзаголовки `##` (полный пересказ), остальной Markdown - нет.
 * `breakOff: false` - обрыв не проверяется: короткое поле анализа (имя, подпись, строка карточки) -
 * фраза, а не законченное предложение (решение арбитра `F07 | F07-1a`, Р10). Нет - проверяется.
 */
export function checkJunk(
  text: string,
  options: { subheadings: boolean; breakOff?: boolean },
): DraftRemark[] {
  const remarks: DraftRemark[] = [];
  const norm = normalized(text);
  const phrase = JUNK_PHRASES.find((p) => hasPhrase(norm, p));
  if (phrase !== undefined) {
    remarks.push(
      codeRemark(
        'JUNK',
        phrase,
        'Remove service phrases and addresses to the reader: return only the text for the site.',
      ),
    );
  }
  const markup = options.subheadings ? text.replace(SUBHEADING_LINE, '') : text;
  if (MARKDOWN.test(markup)) {
    remarks.push(
      codeRemark(
        'JUNK',
        'markdown',
        options.subheadings
          ? 'Use no Markdown except "## " subheadings.'
          : 'This field is plain text: use no Markdown.',
      ),
    );
  }
  const trimmed = text.trim();
  if (options.breakOff !== false && trimmed !== '' && !TEXT_END.test(trimmed)) {
    remarks.push(
      codeRemark('JUNK', trimmed.slice(-WHERE_MAX), 'The text breaks off mid-sentence. Finish it.'),
    );
  }
  return remarks;
}

/**
 * `LANGUAGE_MIXED` (§3): абзац от окна детектора `F05-5`, уверенно определённый не языком
 * версии. Формы глоссария не считаются.
 */
export function checkLanguage(
  text: string,
  language: Language,
  glossary: readonly NameEntry[],
): DraftRemark[] {
  const exclude = glossaryExclusions(glossary);
  return paragraphsOf(text)
    .filter((p) => wordsOf(p).filter((w) => !exclude.has(w)).length >= FOREIGN_WINDOW_WORDS)
    .flatMap((p) => {
      const found = detectLanguage(p, exclude).language;
      if (found === null || found === language) return [];
      return [
        codeRemark(
          'LANGUAGE_MIXED',
          p,
          `This paragraph reads as ${LANGUAGE_NAMES[found]}. Write it in ${LANGUAGE_NAMES[language]}.`,
        ),
      ];
    });
}

/**
 * `NAME_MISMATCH` (§3, часть кода): в тексте стоит форма оригинала записи глоссария - второе,
 * несовместимое написание имени. Правило одно с итоговой проверкой перевода (`divergentEntries`,
 * решение арбитра `F05 | F05-6`, 6c В7): записи в оригинале, совпадающие формы и форма оригинала,
 * равная переводу другой записи, не проверяются. Прочие расхождения - часть проверяющей модели.
 */
export function checkNames(
  text: string,
  language: Language,
  glossary: readonly NameEntry[],
): DraftRemark[] {
  const words = wordsIn(text);
  return divergentEntries(glossary, language)
    .filter((e) => formFound(e.source, words, language))
    .map((e) =>
      codeRemark(
        'NAME_MISMATCH',
        e.source,
        `Write "${e.source}" as "${e.target}", as the glossary says.`,
      ),
    );
}
