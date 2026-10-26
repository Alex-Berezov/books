import { Language } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { mergeAnalysis, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { checkAnalysisRefs } from '../../book-analysis/book-analysis-refs';
import {
  BOOK_ANALYSIS_LIMITS,
  BookAnalysisCharacterDto,
  BookAnalysisFactsDto,
  BookAnalysisKeyQuoteDto,
  BookAnalysisQuoteDto,
  BookAnalysisRelationDto,
  BookAnalysisStyleDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import { Shape } from '../dossier/dossier.format';
import {
  ContentDraftAnalysisDto,
  ContentDraftDroppedQuoteDto,
} from '../dto/content-draft-response.dto';
import { DroppedQuoteReason } from './content-draft.constants';

/**
 * Заготовка Analysis (`F05-11`; `product.md` §5.3, `tech.md` §2б): ответ модели сливается
 * с сохранённым анализом **кодом** (решение арбитра `F05 | F05-11`, Р3) - сохранённые элементы
 * и заполненные поля переносятся как есть, ответ только добавляет новые элементы и заполняет
 * пустые поля. Новые цитаты сверяются дословно с текстом своей главы (Р5-Р7), итог проходит
 * тот же `UpdateBookAnalysisDto` и `checkAnalysisRefs`, что у сохранения анализа (Р2). Язык
 * ставит код (Р11). Ключей толкований и внешних блоков в итоге нет.
 */

const str = 'string' as const;
const int = 'int' as const;

/**
 * Ответ модели. Строгий `response_format` делает поле обязательным, поэтому «нет значения» -
 * пустая строка, «нет главы» - `0`. Роль - и роль досье (`episodic`), и роль анализа (`minor`).
 */
export const ANALYSIS_DRAFT_SHAPE: Shape = {
  object: {
    facts: { object: { settingPlace: str, settingTime: str, narrator: str, structure: str } },
    characters: {
      array: {
        object: {
          key: str,
          name: str,
          role: { enum: ['main', 'secondary', 'minor', 'episodic'] },
          arcFrom: str,
          arcTo: str,
          quote: str,
          quoteChapter: int,
          relations: { array: { object: { to: str, label: str } } },
        },
      },
    },
    keyQuotes: { array: { object: { text: str, chapter: int, speakerKey: str } } },
    style: {
      array: { object: { device: str, explanation: str, example: str, exampleChapter: int } },
    },
  },
};

interface AnswerCharacter {
  key: string;
  name: string;
  role: 'main' | 'secondary' | 'minor' | 'episodic';
  arcFrom: string;
  arcTo: string;
  quote: string;
  quoteChapter: number;
  relations: Array<{ to: string; label: string }>;
}

export interface AnalysisDraftAnswer {
  facts: Record<FillableFact, string>;
  characters: AnswerCharacter[];
  keyQuotes: Array<{ text: string; chapter: number; speakerKey: string }>;
  style: Array<{ device: string; explanation: string; example: string; exampleChapter: number }>;
}

/** Подполя `facts`, которые есть в тексте книги; жанр, направление и годы - внешние (§5.1 п.4). */
const FILLABLE_FACTS = ['settingPlace', 'settingTime', 'narrator', 'structure'] as const;
type FillableFact = (typeof FILLABLE_FACTS)[number];

/** Блоки анализа, которые строит заготовка, - форма ответа ручки (`tech.md` §2б). */
export type AnalysisDraftJson = ContentDraftAnalysisDto;

/** Выкинутая цитата (Р9, Р19) - форма ответа ручки. */
export type DroppedQuote = ContentDraftDroppedQuoteDto;

interface AnalysisDraftResult {
  analysis: AnalysisDraftJson;
  droppedQuotes: DroppedQuote[];
}

/**
 * Нормализация дословности (Р5): пробелы любого вида (NBSP, переводы строк) - один пробел,
 * кавычки - прямые. Регистр, диакритика, тире и многоточие не трогаются.
 */
export function normalizeQuote(text: string): string {
  return text
    .replace(/[«»“”„‟"]/g, '"')
    .replace(/[‘’‚‛']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Абзац главы: исходный текст и его нормализованный вид с картой позиций в исходный. */
interface IndexedParagraph {
  raw: string;
  norm: string;
  /** `at[i]` - позиция символа `norm[i]` в `raw`. */
  at: number[];
}

/** Глава для сверки цитат: абзацы текста `htmlToParagraphs` (Р21 - цитата внутри одного абзаца). */
export type ChapterIndex = ReadonlyMap<number, readonly IndexedParagraph[]>;

/**
 * Нормализованный вид абзаца с картой позиций (Р20): `normalizeQuote` меняет кавычки 1:1,
 * схлопывает пробелы и обрезает края - карта ведёт каждый символ результата в исходный текст.
 */
function indexParagraph(raw: string): IndexedParagraph {
  let norm = '';
  const at: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (norm !== '' && !norm.endsWith(' ')) {
        norm += ' ';
        at.push(i);
      }
      continue;
    }
    norm += normalizeQuote(ch) || ch;
    at.push(i);
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    at.pop();
  }
  return { raw, norm, at };
}

/** Главы версии для сверки: абзацы по пустой строке, как их пишет `htmlToParagraphs`. */
export function indexChapters(chapters: ReadonlyMap<number, string>): ChapterIndex {
  return new Map(
    [...chapters].map(([number, text]) => [
      number,
      text
        .split(/\n\s*\n/)
        .filter((p) => p.trim() !== '')
        .map(indexParagraph),
    ]),
  );
}

/**
 * Проверка цитаты по главе (Р5, Р6, Р21): цитата целиком внутри одного абзаца указанной главы
 * после нормализации. Нашлась - отдаётся фрагмент главы, а не текст модели (Р20): кавычки
 * и пробелы цитаты - как в читалке.
 */
export function quoteCheck(
  text: string,
  chapter: number,
  chapters: ChapterIndex,
): { text: string } | { reason: DroppedQuoteReason } {
  if (chapter <= 0) return { reason: 'NO_CHAPTER' };
  const paragraphs = chapters.get(chapter);
  if (paragraphs === undefined) return { reason: 'CHAPTER_MISSING' };
  const quote = normalizeQuote(text);
  if (quote === '') return { reason: 'NOT_FOUND' };
  for (const p of paragraphs) {
    const start = p.norm.indexOf(quote);
    if (start < 0) continue;
    const end = p.at[start + quote.length - 1] + 1;
    const fragment = p.raw.slice(p.at[start], end).trim();
    // Длиннее предела импорта из-за пробельных серий главы - те же символы со схлопнутыми
    // пробелами: длина как у нормализованной цитаты, кавычки как в читалке (Р25).
    return {
      text:
        fragment.length > BOOK_ANALYSIS_LIMITS.quote
          ? fragment.replace(/\s+/g, ' ').trim()
          : fragment,
    };
  }
  return { reason: 'NOT_FOUND' };
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const sameText = (a: string, b: string): boolean =>
  normalizeQuote(a).toLowerCase() === normalizeQuote(b).toLowerCase();

const roleOf = (role: AnswerCharacter['role']): BookAnalysisCharacterDto['role'] =>
  role === 'episodic' ? 'minor' : role;

const relationsOf = (relations: AnswerCharacter['relations']): BookAnalysisRelationDto[] =>
  relations
    .map((r) => ({ to: r.to.trim(), label: r.label.trim() }))
    .filter((r) => r.to !== '' && r.label !== '');

/**
 * Слияние ответа с сохранённым анализом (Р3) и выброс непроверенных цитат (Р6, Р7). Сохранённое
 * переносится как есть и не проверяется; у сохранённого героя или приёма ответ заполняет только
 * пустые поля. Цитат всего не больше предела импорта вместе с сохранёнными (Р1): лишние новые
 * отрезаются после проверки.
 */
export function buildAnalysisDraft(input: {
  language: Language;
  stored: StoredBookAnalysis;
  answer: AnalysisDraftAnswer;
  chapters: ChapterIndex;
}): AnalysisDraftResult {
  const { stored, answer, chapters } = input;
  const dropped: DroppedQuote[] = [];
  /** Цитата ответа - `{text, chapter}` после проверки; не прошла - `null` и строка в `dropped`. */
  const verified = (path: string, text: string, chapter: number): BookAnalysisQuoteDto | null => {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const found = quoteCheck(trimmed, chapter, chapters);
    if ('text' in found) return { text: found.text, chapter };
    dropped.push({
      path,
      text: trimmed,
      chapter: chapter > 0 ? chapter : null,
      reason: found.reason,
    });
    return null;
  };

  const facts: BookAnalysisFactsDto = { ...(stored.facts ?? {}) };
  for (const key of FILLABLE_FACTS) {
    const value = answer.facts[key]?.trim() ?? '';
    if (isEmpty(facts[key]) && value !== '') facts[key] = value;
  }

  const characters: BookAnalysisCharacterDto[] = (stored.characters ?? []).map((c) => ({ ...c }));
  // Герой ответа, совпавший с сохранённым по имени, мог прийти под своим ключом: ссылки ответа на
  // этот ключ (`relations[].to`, `speakerKey`) переводятся на ключ сохранённого, иначе висят.
  const keyOf = new Map<string, string>();
  const pendingRelations: Array<{
    target: BookAnalysisCharacterDto;
    relations: BookAnalysisRelationDto[];
  }> = [];
  for (const a of answer.characters) {
    const key = a.key.trim();
    const name = a.name.trim();
    if (key === '' || name === '') continue;
    const own = characters.find((c) => c.key === key || sameText(c.name, name));
    const target = own ?? { key, name, role: roleOf(a.role) };
    keyOf.set(key, target.key);
    const path = `characters.${target.key}.quote`;
    if (isEmpty(target.arc) && a.arcFrom.trim() !== '' && a.arcTo.trim() !== '') {
      target.arc = { from: a.arcFrom.trim(), to: a.arcTo.trim() };
    }
    if (isEmpty(target.quote)) {
      const quote = verified(path, a.quote, a.quoteChapter);
      if (quote) target.quote = quote;
    }
    const relations = relationsOf(a.relations);
    if (isEmpty(target.relations) && relations.length > 0) {
      pendingRelations.push({ target, relations });
    }
    if (!own) characters.push(target);
  }
  // Связи - после всех героев: ключ цели известен, только когда разобран её герой.
  const mapped = (key: string) => keyOf.get(key) ?? key;
  for (const { target, relations } of pendingRelations) {
    target.relations = relations.map((r) => ({ ...r, to: mapped(r.to) }));
  }

  const keyQuotes: BookAnalysisKeyQuoteDto[] = (stored.keyQuotes ?? []).map((q) => ({ ...q }));
  for (const a of answer.keyQuotes) {
    const speakerKey = a.speakerKey.trim() === '' ? '' : mapped(a.speakerKey.trim());
    const own = keyQuotes.find((q) => sameText(q.text, a.text));
    if (own) {
      if (isEmpty(own.speakerKey) && speakerKey !== '') own.speakerKey = speakerKey;
      continue;
    }
    const quote = verified('keyQuotes', a.text, a.chapter);
    if (!quote) continue;
    // Сначала проверка, потом предел вместе с сохранёнными (Р1, Р19): лишняя - с пометкой.
    if (keyQuotes.length >= BOOK_ANALYSIS_LIMITS.keyQuotes) {
      dropped.push({
        path: 'keyQuotes',
        text: quote.text,
        chapter: quote.chapter ?? null,
        reason: 'OVER_LIMIT',
      });
      continue;
    }
    keyQuotes.push({ ...quote, ...(speakerKey !== '' ? { speakerKey } : {}) });
  }

  const style: BookAnalysisStyleDto[] = (stored.style ?? []).map((s) => ({ ...s }));
  for (const a of answer.style) {
    const device = a.device.trim();
    if (device === '') continue;
    const own = style.find((s) => sameText(s.device, device));
    const target = own ?? { device, explanation: a.explanation.trim() };
    if (isEmpty(target.explanation) && a.explanation.trim() !== '') {
      target.explanation = a.explanation.trim();
    }
    if (isEmpty(target.example)) {
      const position = own ? style.indexOf(own) : style.length;
      const example = verified(`style.${position}.example`, a.example, a.exampleChapter);
      if (example) target.example = example;
    }
    if (!own) style.push(target);
  }

  const analysis: AnalysisDraftJson = { language: input.language };
  // Пустой блок не отдаётся: ключа нет - импорт блок не трогает, `[]` очистил бы его.
  if (Object.values(facts).some((v) => !isEmpty(v))) analysis.facts = facts;
  if (characters.length > 0) analysis.characters = characters;
  if (keyQuotes.length > 0) analysis.keyQuotes = keyQuotes;
  if (style.length > 0) analysis.style = style;
  return { analysis, droppedQuotes: dropped };
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((m) => `${prefix}${e.property}: ${m}`),
    ...flatten(e.children ?? [], `${prefix}${e.property}.`),
  ]);
}

/**
 * Ошибки, на которых сохранение анализа отказало бы (Р2): тело - через `UpdateBookAnalysisDto`
 * с опциями боевого `ValidationPipe` (`main.ts`), ссылки - `checkAnalysisRefs` по записи после
 * слияния, как у `PUT versions/:id/analysis`. Не копия схемы: те же классы и та же функция.
 */
export function analysisImportErrors(
  stored: StoredBookAnalysis,
  analysis: AnalysisDraftJson,
): string[] {
  const dto = plainToInstance(UpdateBookAnalysisDto, analysis);
  const errors = flatten(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }));
  if (errors.length > 0) return errors;
  return checkAnalysisRefs(mergeAnalysis(stored, dto)).map((e) => `${e.path}: ${e.message}`);
}

/** Элемент слитого списка по имени, а не по индексу: в ответе модели только новые элементы. */
function itemName(analysis: AnalysisDraftJson, block: string, index: number): string | null {
  if (block === 'characters') {
    const key = analysis.characters?.[index]?.key;
    return key === undefined ? null : `characters[key=${key}]`;
  }
  if (block === 'style') {
    const device = analysis.style?.[index]?.device;
    return device === undefined ? null : `style[device=${device}]`;
  }
  if (block === 'keyQuotes') {
    const text = analysis.keyQuotes?.[index]?.text;
    return text === undefined ? null : `keyQuotes[text="${text.slice(0, 60)}"]`;
  }
  return null;
}

/**
 * Замечание модели после проверок сохранения (Р27): пути слитой записи (`characters.17.…`)
 * модели не найти в своём ответе, поэтому начало пути `<блок>.<i>` переводится в имя элемента.
 * `facts` и хвост пути - как есть; ошибки `PUT versions/:id/analysis` этим не меняются.
 */
export function analysisRemarks(stored: StoredBookAnalysis, analysis: AnalysisDraftJson): string[] {
  return analysisImportErrors(stored, analysis).map((error) =>
    error.replace(
      /^(characters|style|keyQuotes)\.(\d+)/,
      (whole, block: string, i: string) => itemName(analysis, block, Number(i)) ?? whole,
    ),
  );
}

/**
 * Сохранённые блоки, которые заготовка дополняет, - вход модели: она видит, что уже есть, и не
 * повторяет. Блоки толкований (темы, символы) ей не нужны.
 */
export function draftBlocksOf(stored: StoredBookAnalysis): Record<string, unknown> {
  return {
    facts: stored.facts,
    characters: stored.characters,
    keyQuotes: stored.keyQuotes,
    style: stored.style,
  };
}
