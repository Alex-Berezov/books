import { Language } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import {
  BOOK_WORLD_LIMITS,
  WIKIDATA_ID_MAX,
  WIKIDATA_ID_REGEX,
  WORLD_PLACE_KINDS,
  type WorldPlaceKind,
} from '../../book-world/dto/book-world-blocks.dto';
import type {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldCompareDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
} from '../../book-world/dto/book-world-blocks.dto';
import { appearancePrint, briefBasisOf, worldTypeHasBlock } from '../../book-world/book-world-data';
import { WORLD_IMAGE_ROLES } from '../../book-world/world-image-public';
import { BookWorldEntityInputDto } from '../../book-world/dto/update-book-world.dto';
import {
  computeWorldCore,
  WORLD_PAIR_CORE,
  WORLD_PLACE_CORE,
  type WorldCorePart,
} from '../../book-world/world-core';
import { countInParagraph, foldMention, mentionForms } from '../../book-world/world-mentions';
import { quoteStandsIn } from '../../book-world/world-quote-check';
import { wikidataIdAllowed } from '../../book-world/world-refs';
import type { BookAnalysisFaqDto } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { BookAnalysisSourceDto } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { NameEntry } from '../check/mechanical-check';
import { glossaryNames } from '../draft-quality/draft-context';
import { intOf } from '../draft-quality/draft-record';
import { ChapterIndex } from '../draft-quality/quote-check';
import {
  checkJunk,
  checkLanguage,
  checkNames,
  codeRemark,
  DraftRemark,
} from '../draft-quality/text-checks';
import { hostOf, PageCheck, pageIsAbout } from '../analysis-write/analysis-write.external';
import {
  DroppedWorldQuote,
  DroppedWorldSource,
  WorldDossierType,
  WorldExternalBlock,
  WorldFix,
  WorldRunObjectType,
  WorldSource,
} from './world-write.data';

/**
 * Код-проверки хода мира (`F08-4a`; `features/F08-book-wiki/tech.md` §5): чтение ответов шагов
 * с правками кода (что снято - с причиной в `fixes`) и замечания, которые зовут переделку.
 * Цитаты сверяются тем же правилом, что импорт мира (`world-quote-check`, решение арбитра
 * `F08 | F08-4`, Q8): иначе ход оставил бы цитату, которую запись отобьёт.
 */

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const textOrNull = (v: unknown): string | null => (trimmed(v) === '' ? null : trimmed(v));
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const chapterOf = intOf;

/**
 * Имя из ответа модели - только в пределе импорта (`BookWorldEntityInputDto.name`): длиннее -
 * не берётся, остаётся имя анализа. Иначе оно ушло бы в сущность мимо проверки DTO.
 */
const nameOf = (v: unknown): string | null => {
  const name = textOrNull(v);
  return name !== null && name.length <= BOOK_WORLD_LIMITS.name ? name : null;
};

/** Хвост сверх предела импорта отрезается с причиной (`LIMIT_OUT`, решение арбитра Q7). */
function limited<T>(items: T[], max: number, path: string, fixes: WorldFix[]): T[] {
  if (items.length <= max) return items;
  fixes.push({
    code: 'LIMIT_OUT',
    path,
    note: `${items.length - max} of ${items.length} cut: the import takes at most ${max}`,
  });
  return items.slice(0, max);
}

// ---------------------------------------------------------------- выбор героев

/** Ответ выбора героев после кода: имя и проверенные формы по ключу кандидата. */
export interface WorldSelectDraft {
  characters: Array<{ key: string; name: string; aliases: string[] }>;
  /** Формы названий кандидатов-мест (`F08-12b`, решение `F08 | F08-12b` Q1) - то же правило. */
  places: Array<{ key: string; name: string; aliases: string[] }>;
  /**
   * Формы названий кандидатов-предметов и кандидатов-понятий (`F08-13b`) - то же правило. Оплаченный
   * черновик выбора старой формы (сохранён до `F08-13b`, продолжается после обрыва) их не несёт:
   * читается как пустые (`selectForms`).
   */
  objects?: Array<{ key: string; name: string; aliases: string[] }>;
  terms?: Array<{ key: string; name: string; aliases: string[] }>;
  fixes: WorldFix[];
}

export const EMPTY_SELECT: WorldSelectDraft = {
  characters: [],
  places: [],
  objects: [],
  terms: [],
  fixes: [],
};

/**
 * Формы одного списка ответа выбора - и у черновика старой формы (до `F08-12b` нет `places`, до
 * `F08-13b` - `objects` и `terms`): поля нет - форм нет, а не сбой шага.
 */
export function selectForms(
  answer: WorldSelectDraft | null,
  list: 'characters' | 'places' | 'objects' | 'terms',
): WorldSelectDraft['characters'] {
  const forms: unknown = answer?.[list];
  return Array.isArray(forms) ? (forms as WorldSelectDraft['characters']) : [];
}

/**
 * Абзацы текста версии в виде сравнения форм (`foldMention`): форма имени стоит в тексте, если она
 * есть целым словом хотя бы в одном абзаце - то же правило, что у подсчёта присутствия.
 */
export function foldedVersion(chapters: ChapterIndex): string[] {
  return [...chapters.values()].flatMap((paragraphs) => paragraphs.map((p) => foldMention(p.raw)));
}

const formInText = (form: string, folded: readonly string[]): boolean => {
  const forms = mentionForms({ key: '', name: form, aliases: [], aliasExclusions: [] });
  return forms.length > 0 && folded.some((p) => countInParagraph(p, forms) > 0);
};

/**
 * Ответ выбора героев (`tech.md` §4): только ключи кандидатов (герои `main` анализа, Q3/Q4);
 * форма имени, которой нет в тексте версии целым словом или короче трёх букв, отбрасывается
 * (`ALIAS_NOT_IN_TEXT`); имя без единой формы в тексте остаётся - его берут как есть.
 */
export function readSelectAnswer(
  value: unknown,
  candidates: ReadonlyArray<{ key: string; name: string }>,
  folded: readonly string[],
  places: ReadonlyArray<{ key: string; name: string }> = [],
  objects: ReadonlyArray<{ key: string; name: string }> = [],
  terms: ReadonlyArray<{ key: string; name: string }> = [],
): WorldSelectDraft {
  const fixes: WorldFix[] = [];
  const v = rec(value);
  return {
    characters: readForms(v.characters, candidates, 'characters', folded, fixes),
    places: readForms(v.places, places, 'places', folded, fixes),
    objects: readForms(v.objects, objects, 'objects', folded, fixes),
    terms: readForms(v.terms, terms, 'terms', folded, fixes),
    fixes,
  };
}

/** Формы одного списка ответа выбора (героев или мест): только ключи кандидатов, формы - по тексту. */
function readForms(
  raws: unknown,
  candidates: ReadonlyArray<{ key: string; name: string }>,
  path: string,
  folded: readonly string[],
  fixes: WorldFix[],
): WorldSelectDraft['characters'] {
  const known = new Map(candidates.map((c) => [c.key, c]));
  const out: WorldSelectDraft['characters'] = [];
  list(raws).forEach((raw, i) => {
    const c = rec(raw);
    const key = trimmed(c.key);
    const candidate = known.get(key);
    if (!candidate || out.some((x) => x.key === key)) {
      fixes.push({
        code: 'KEY_UNKNOWN',
        path: `${path}.${i}`,
        note: `"${key}" is not a candidate`,
      });
      return;
    }
    const aliases: string[] = [];
    list(c.aliases).forEach((form, j) => {
      const text = trimmed(form);
      if (text === '' || aliases.includes(text)) return;
      if (text.length > BOOK_WORLD_LIMITS.name) {
        fixes.push({
          code: 'IMPORT_INVALID',
          path: `${path}.${i}.aliases.${j}`,
          note: `longer than ${BOOK_WORLD_LIMITS.name} characters: removed`,
        });
        return;
      }
      if (!formInText(text, folded)) {
        fixes.push({
          code: 'ALIAS_NOT_IN_TEXT',
          path: `${path}.${i}.aliases.${j}`,
          note: `"${text}" is not in the text of this version as a whole word: removed`,
        });
        return;
      }
      aliases.push(text);
    });
    out.push({
      key,
      name: nameOf(c.name) ?? candidate.name,
      aliases: limited(aliases, BOOK_WORLD_LIMITS.aliases, `${path}.${i}.aliases`, fixes),
    });
  });
  return out;
}

/**
 * Формы имени героя из досье и глоссария (`tech.md` §4): имя и варианты героя досье (по ключу,
 * иначе по имени), формы, которыми к нему обращаются другие (`address[].to` - его ключ), и `target`
 * записей глоссария с тем же ключом. Каждая - только если стоит в тексте версии целым словом
 * (как ответ модели) и в пределе импорта; падежные формы даёт модель выбора героев.
 */
export function dossierForms(
  candidate: { key: string; name: string },
  dossier: unknown,
  glossary: unknown,
  folded: readonly string[],
): string[] {
  const characters = list(rec(dossier).characters).map(rec);
  const own =
    characters.find((c) => trimmed(c.key) === candidate.key) ??
    characters.find((c) => foldMention(trimmed(c.name)) === foldMention(candidate.name));
  const raw = [
    ...(own ? [trimmed(own.name), ...list(own.variants).map(trimmed)] : []),
    ...characters.flatMap((c) =>
      list(c.address)
        .map(rec)
        .filter(
          (a) => trimmed(a.to) === candidate.key || (own && trimmed(a.to) === trimmed(own.key)),
        )
        .map((a) => trimmed(a.form)),
    ),
    ...glossaryNames(glossary)
      // Ключ глоссария - ключ досье; у героя анализа он может быть другим (решение арбитра `F08 | F08-4a`).
      .filter((e) => e.key === candidate.key || (own !== undefined && e.key === trimmed(own.key)))
      .map((e) => e.target.trim()),
  ];
  return [...new Set(raw)].filter(
    (form) => form !== '' && form.length <= BOOK_WORLD_LIMITS.name && formInText(form, folded),
  );
}

/**
 * Формы названия места из досье и глоссария (`F08-12b`, решение `F08 | F08-12b` Q1): название места
 * досье с тем же ключом и `target` записей глоссария с этим ключом; каждая - только если стоит
 * в тексте версии целым словом и в пределе импорта. Падежные формы даёт модель выбора.
 */
export function placeDossierForms(
  key: string,
  dossier: unknown,
  glossary: unknown,
  folded: readonly string[],
): string[] {
  return dossierEntityForms(key, 'place', dossier, glossary, folded);
}

/**
 * Формы названия сущности досье вида `kind` (место, предмет, понятие - `F08-13b`): одно правило
 * `placeDossierForms` - название досье с тем же ключом и `target` глоссария, только стоящие в тексте.
 */
export function dossierEntityForms(
  key: string,
  kind: WorldDossierType,
  dossier: unknown,
  glossary: unknown,
  folded: readonly string[],
): string[] {
  const own = list(rec(dossier).entities)
    .map(rec)
    .find((e) => trimmed(e.kind) === kind && trimmed(e.key) === key);
  const raw = [
    ...(own ? [trimmed(own.name)] : []),
    ...glossaryNames(glossary)
      .filter((e) => e.key === key)
      .map((e) => e.target.trim()),
  ];
  return [...new Set(raw)].filter(
    (form) => form !== '' && form.length <= BOOK_WORLD_LIMITS.name && formInText(form, folded),
  );
}

// ---------------------------------------------------------------- страница героя

/** Блоки страницы героя (без `aliases`: их пишет выбор героев). */
export interface WorldPageBlocks {
  short?: string;
  profile?: BookWorldProfileDto;
  appearance?: string;
  character?: string;
  arc?: BookWorldArcDto;
  scenes?: BookWorldSceneDto[];
  relations?: BookWorldRelationDto[];
  quotes?: BookWorldQuoteDto[];
  faq?: BookAnalysisFaqDto[];
  imageBrief?: string;
}

export interface WorldPageDraft {
  name: string | null;
  blocks: WorldPageBlocks;
  fixes: WorldFix[];
  droppedQuotes: DroppedWorldQuote[];
  /** Отпечаток «Внешности», по которой написано ТЗ (`appearancePrint`); ТЗ нет — поля нет. */
  briefFor?: string | null;
}

export const EMPTY_PAGE: WorldPageDraft = { name: null, blocks: {}, fixes: [], droppedQuotes: [] };

/** Что знает код о версии и герое страницы. */
export interface WorldPageCheck {
  key: string;
  language: Language;
  chapters: ChapterIndex;
  /** Главы, где формы имени нашли героя (посчитано до страницы). */
  mentionChapters: ReadonlySet<number>;
  /** Ключи, на которые можно ссылаться: кандидаты, герои анализа, сущности мира версии. */
  refKeys: ReadonlySet<string>;
  glossary: readonly NameEntry[];
  /**
   * «Внешность» сохранённой сущности — только при перегенерации одного блока `imageBrief`: ответ
   * несёт только его, и условие ТЗ (Q10) проверяется по записанному тексту; иначе `null`.
   */
  storedAppearance: string | null;
  /** Перегенерация одного блока `imageBrief`: облик — только `storedAppearance`, «Внешность» ответа не в счёт. */
  briefRegen: boolean;
  /** Роль героя: сохранённой сущности, иначе кандидата. ТЗ — только у `main`/`secondary` (Q2, Q10). */
  role: string | null;
}

/** Глава из версии: одно правило на сцены, этапы, строки сравнения и цитаты страницы и пары. */
function chapterKnown(chapters: ChapterIndex, n: number | null): n is number {
  return n !== null && chapters.has(n);
}

/**
 * Общий отсев цитаты страницы и пары: глава не из версии (`CHAPTER_UNKNOWN`) или текст не дословно
 * в главе (`QUOTE_NOT_VERBATIM`) - причина дописывается в `droppedQuotes` и в `fixes`, ответ
 * `null` (цитата выброшена); иначе - глава цитаты. Зовётся ровно один раз на цитату: каждый вызов
 * пишет в оба списка.
 */
function quoteChapterOrDrop(
  text: string,
  chapter: number | null,
  path: string,
  check: { key: string; chapters: ChapterIndex },
  fixes: WorldFix[],
  droppedQuotes: DroppedWorldQuote[],
): number | null {
  if (!chapterKnown(check.chapters, chapter)) {
    droppedQuotes.push({ key: check.key, chapter, text, reason: 'CHAPTER_UNKNOWN' });
    fixes.push(chapterFix(path, chapter));
    return null;
  }
  if (!quoteStandsIn(text, check.chapters.get(chapter) ?? [])) {
    droppedQuotes.push({ key: check.key, chapter, text, reason: 'QUOTE_NOT_VERBATIM' });
    fixes.push({
      code: 'QUOTE_NOT_VERBATIM',
      path,
      note: `not word for word in chapter ${chapter}: removed`,
    });
    return null;
  }
  return chapter;
}

/**
 * Сцены ответа шага (страница героя и место, решение арбитра `F08 | F08-12b` R4): сцена с главой
 * не версии - выброшена (`CHAPTER_UNKNOWN`), хвост сверх предела импорта - отрезан (Q7).
 */
function readScenes(
  raws: unknown,
  chapters: ChapterIndex,
  fixes: WorldFix[],
): BookWorldSceneDto[] | undefined {
  const scenes = list(raws).flatMap((raw, i) => {
    const sc = rec(raw);
    const chapter = chapterOf(sc.chapter);
    if (!chapterKnown(chapters, chapter)) {
      fixes.push(chapterFix(`scenes.${i}`, chapter));
      return [];
    }
    return [{ chapter, title: trimmed(sc.title), text: trimmed(sc.text) }];
  });
  return scenes.length > 0 ? limited(scenes, BOOK_WORLD_LIMITS.scenes, 'scenes', fixes) : undefined;
}

/**
 * Цитаты ответа шага со `speakerKey` (страница героя и место, R4): глава не версии или не дословно -
 * выброшена (`quoteChapterOrDrop`); говорящий не из `speakerOk` - без `speakerKey` (`KEY_UNKNOWN`
 * с `speakerNote`); хвост сверх предела импорта - отрезан.
 */
function readSpeakerQuotes(
  raws: unknown,
  check: { key: string; chapters: ChapterIndex },
  speakerOk: (key: string) => boolean,
  speakerNote: string,
  fixes: WorldFix[],
  droppedQuotes: DroppedWorldQuote[],
): BookWorldQuoteDto[] | undefined {
  const quotes = list(raws).flatMap((raw, i) => {
    const q = rec(raw);
    const text = trimmed(q.text);
    const chapter = quoteChapterOrDrop(
      text,
      chapterOf(q.chapter),
      `quotes.${i}`,
      check,
      fixes,
      droppedQuotes,
    );
    if (chapter === null) return [];
    const speaker = trimmed(q.speakerKey);
    let speakerKey: string | undefined;
    if (speaker !== '') {
      if (speakerOk(speaker)) speakerKey = speaker;
      else {
        fixes.push({
          code: 'KEY_UNKNOWN',
          path: `quotes.${i}.speakerKey`,
          note: `"${speaker}" ${speakerNote}: the speaker is left out`,
        });
      }
    }
    return [
      {
        text,
        chapter,
        ...(speakerKey ? { speakerKey } : {}),
        interpretation: trimmed(q.interpretation),
      },
    ];
  });
  return quotes.length > 0 ? limited(quotes, BOOK_WORLD_LIMITS.quotes, 'quotes', fixes) : undefined;
}

/** Частые вопросы ответа шага (герой, пара, место, R4): хвост сверх предела импорта - отрезан. */
function readFaq(raws: unknown, fixes: WorldFix[]): BookAnalysisFaqDto[] | undefined {
  const faq = list(raws).map((raw) => {
    const f = rec(raw);
    return { question: trimmed(f.question), answer: trimmed(f.answer) };
  });
  return faq.length > 0 ? limited(faq, BOOK_WORLD_LIMITS.faq, 'faq', fixes) : undefined;
}

/**
 * Ответ страницы после кода: цитата с главой не версии или не дословная - выброшена с причиной
 * (`droppedQuotes`), затем хвост сверх 12 отрезан (Q7); сцена и этап с главой не версии -
 * выброшены (`CHAPTER_UNKNOWN`); ссылка на неизвестный ключ или на себя - выброшена, говорящий
 * без ключа - без `speakerKey` (`KEY_UNKNOWN`); прочие списки - по пределам импорта.
 */
export function readPageAnswer(value: unknown, check: WorldPageCheck): WorldPageDraft {
  const v = rec(value);
  const fixes: WorldFix[] = [];
  const droppedQuotes: DroppedWorldQuote[] = [];
  const known = (n: number | null): n is number => chapterKnown(check.chapters, n);
  const blocks: WorldPageBlocks = {};

  const short = textOrNull(v.short);
  if (short) blocks.short = short;
  const appearance = textOrNull(v.appearance);
  if (appearance) blocks.appearance = appearance;
  const character = textOrNull(v.character);
  if (character) blocks.character = character;
  // ТЗ — только у героя `main`/`secondary` и только с «Внешностью» (решения `F08 | F08-11d` Q2, Q10 и
  // `F08 | F08-11d-2`): решает код, а не ответ модели. Отпечаток — по той «Внешности», по которой написано.
  const imageBrief = textOrNull(v.imageBrief);
  // При перегенерации одного ТЗ облик — сохранённая «Внешность»: «Внешность» ответа отбрасывается.
  const look = check.briefRegen
    ? check.storedAppearance
    : briefBasisOf('character', { appearance: appearance ?? null });
  let briefFor: string | null | undefined;
  if (imageBrief && !(WORLD_IMAGE_ROLES as readonly string[]).includes(check.role ?? '')) {
    fixes.push({
      code: 'BRIEF_NOT_ALLOWED',
      path: 'imageBrief',
      note: 'not a main or secondary character: the brief is removed',
    });
  } else if (imageBrief && !look) {
    fixes.push({
      code: 'BRIEF_WITHOUT_APPEARANCE',
      path: 'imageBrief',
      note: 'no appearance: the brief is removed',
    });
  } else if (imageBrief) {
    blocks.imageBrief = imageBrief;
    briefFor = appearancePrint(look);
  }
  const profile = rec(v.profile);
  const position = textOrNull(profile.position);
  const relationToMain = textOrNull(profile.relationToMain);
  if (position || relationToMain) {
    blocks.profile = {
      ...(position ? { position } : {}),
      ...(relationToMain ? { relationToMain } : {}),
    };
  }

  const arc = rec(v.arc);
  if (textOrNull(arc.from) || textOrNull(arc.to)) {
    const stages = list(arc.stages).flatMap((raw, i) => {
      const s = rec(raw);
      const chapter = chapterOf(s.chapter);
      if (!known(chapter)) {
        fixes.push(chapterFix(`arc.stages.${i}`, chapter));
        return [];
      }
      return [{ title: trimmed(s.title), text: trimmed(s.text), chapter }];
    });
    blocks.arc = {
      from: trimmed(arc.from),
      to: trimmed(arc.to),
      ...(stages.length > 0
        ? { stages: limited(stages, BOOK_WORLD_LIMITS.stages, 'arc.stages', fixes) }
        : {}),
    };
  }

  const scenes = readScenes(v.scenes, check.chapters, fixes);
  if (scenes) blocks.scenes = scenes;

  const relations = list(v.relations).flatMap((raw, i) => {
    const r = rec(raw);
    const to = trimmed(r.to);
    if (to === check.key || !check.refKeys.has(to)) {
      fixes.push({
        code: 'KEY_UNKNOWN',
        path: `relations.${i}`,
        note: `"${to}" is not a known key`,
      });
      return [];
    }
    return [{ to, label: trimmed(r.label) }];
  });
  if (relations.length > 0) {
    blocks.relations = limited(relations, BOOK_WORLD_LIMITS.relations, 'relations', fixes);
  }

  const quotes = readSpeakerQuotes(
    v.quotes,
    check,
    (speaker) => check.refKeys.has(speaker) || speaker === check.key,
    'is not a known key',
    fixes,
    droppedQuotes,
  );
  if (quotes) blocks.quotes = quotes;

  const faq = readFaq(v.faq, fixes);
  if (faq) blocks.faq = faq;

  return {
    name: nameOf(v.name),
    blocks,
    fixes,
    droppedQuotes,
    ...(briefFor !== undefined ? { briefFor } : {}),
  };
}

const chapterFix = (path: string, chapter: number | null): WorldFix => ({
  code: 'CHAPTER_UNKNOWN',
  path,
  note: `chapter ${chapter ?? 'none'} is not in this version: removed`,
});

/**
 * Блок по пути замечания или ошибки DTO (`quotes.2.interpretation`, `short: фрагмент`) - одно
 * правило на запрет записи блока (`invalidBlocks`) и на флаги пункта (`remarksOfBlock`, L-017).
 */
export const blockOfPath = (path: string): string => path.split(/[.[:\s]/, 1)[0];

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((m) => `${prefix}${e.property}: ${m}`),
    ...flatten(e.children ?? [], `${prefix}${e.property}.`),
  ]);
}

/**
 * Ошибки DTO импорта мира (`IMPORT_INVALID` с путём, `tech.md` §5) по блокам ответа: те же классы
 * и опции, что у `PUT versions/:id/world/:key`. Только поля этих блоков.
 */
export function importRemarks(
  key: string,
  name: string,
  blocks: object,
  type: 'character' | 'pair' | 'place' | 'object' | 'term' = 'character',
): DraftRemark[] {
  const own = new Set(Object.keys(blocks));
  const dto = plainToInstance(BookWorldEntityInputDto, {
    key,
    type,
    name,
    ...(type === 'character' ? { role: 'main' } : {}),
    ...blocks,
  });
  return flatten(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }))
    .filter((error) => own.has(blockOfPath(error)))
    .map((error) =>
      codeRemark(
        'IMPORT_INVALID',
        error.slice(0, error.indexOf(':')),
        `The field ${error}. Fix this field or leave the element out.`,
      ),
    );
}

/** Блоки с ошибкой импорта после переделки: не пишутся (их пункт - `IMPORT_INVALID`). */
export const invalidBlocks = (remarks: readonly DraftRemark[]): Set<string> =>
  new Set(remarks.filter((r) => r.code === 'IMPORT_INVALID').map((r) => blockOfPath(r.where)));

interface TextField {
  path: string;
  text: string;
  long: boolean;
}

function pageFields(blocks: WorldPageBlocks): TextField[] {
  const fields: TextField[] = [];
  const add = (path: string, text: string | null | undefined, long: boolean) => {
    if (typeof text === 'string' && text.trim() !== '') fields.push({ path, text, long });
  };
  add('short', blocks.short, true);
  add('profile.position', blocks.profile?.position, false);
  add('profile.relationToMain', blocks.profile?.relationToMain, false);
  add('appearance', blocks.appearance, true);
  add('character', blocks.character, true);
  // «В начале» и «в конце» - фразы, а не предложения (эталон `example-world.*.json`): обрыв на
  // полуслове у них не проверяется, иначе каждая страница по канону уходила бы на переделку.
  add('arc.from', blocks.arc?.from, false);
  add('arc.to', blocks.arc?.to, false);
  (blocks.arc?.stages ?? []).forEach((s, i) => add(`arc.stages.${i}.text`, s.text, true));
  (blocks.scenes ?? []).forEach((s, i) => add(`scenes.${i}.text`, s.text, true));
  (blocks.relations ?? []).forEach((r, i) => add(`relations.${i}.label`, r.label, false));
  (blocks.quotes ?? []).forEach((q, i) =>
    add(`quotes.${i}.interpretation`, q.interpretation, true),
  );
  (blocks.faq ?? []).forEach((f, i) => {
    add(`faq.${i}.question`, f.question, false);
    add(`faq.${i}.answer`, f.answer, true);
  });
  return fields;
}

const WHERE_PATH_MAX = 80;

const atPath = (path: string, remark: DraftRemark): DraftRemark => {
  const where = `${path}: ${remark.where}`;
  return {
    ...remark,
    where: where.length > WHERE_PATH_MAX ? `${where.slice(0, WHERE_PATH_MAX - 1)}…` : where,
  };
};

function textRemarks(
  fields: readonly TextField[],
  language: Language,
  glossary: readonly NameEntry[],
): DraftRemark[] {
  return fields.flatMap((f) =>
    [
      ...checkJunk(f.text, { subheadings: false, breakOff: f.long }),
      ...checkLanguage(f.text, language, glossary),
      ...checkNames(f.text, language, glossary),
    ].map((r) => atPath(f.path, r)),
  );
}

/**
 * Сцены и этапы пути - только в главах, где формы имени нашли героя (`tech.md` §5): иначе
 * замечание и переделка; после переделки - флаг (решение арбитра `F08 | F08-4`, Q6 - то же
 * правило одной переделки).
 */
export function mentionRemarks(
  blocks: WorldPageBlocks,
  mentionChapters: ReadonlySet<number>,
  subject: 'character' | 'place' = 'character',
): DraftRemark[] {
  const outside = (path: string, chapter: number) =>
    codeRemark(
      'SCENE_OUTSIDE_MENTIONS',
      path,
      `The ${subject} is not found by the name forms in chapter ${chapter}: take a scene from a chapter where the ${subject} is, or leave it out.`,
    );
  return [
    ...(blocks.scenes ?? []).flatMap((s, i) =>
      mentionChapters.has(s.chapter) ? [] : [outside(`scenes.${i}`, s.chapter)],
    ),
    ...(blocks.arc?.stages ?? []).flatMap((s, i) =>
      mentionChapters.has(s.chapter) ? [] : [outside(`arc.stages.${i}`, s.chapter)],
    ),
  ];
}

/** Замечания кода к странице: импорт, глава без героя, текст (язык, имена, мусор). */
export function pageRemarks(
  draft: WorldPageDraft,
  check: WorldPageCheck,
  name: string,
): DraftRemark[] {
  return [
    ...importRemarks(check.key, draft.name ?? name, draft.blocks),
    ...mentionRemarks(draft.blocks, check.mentionChapters),
    ...textRemarks(pageFields(draft.blocks), check.language, check.glossary),
  ];
}

// ---------------------------------------------------------------- страница пары

/** Блоки страницы пары (`F08-8e`; `prompts/world-pair.md`, «Структура ответа»). */
export interface WorldPairBlocks {
  short?: string;
  compare?: BookWorldCompareDto[];
  bonds?: string;
  differences?: string;
  conclusion?: string;
  quotes?: BookWorldQuoteDto[];
  faq?: BookAnalysisFaqDto[];
}

export interface WorldPairDraft {
  name: string | null;
  blocks: WorldPairBlocks;
  fixes: WorldFix[];
  droppedQuotes: DroppedWorldQuote[];
}

export const EMPTY_PAIR: WorldPairDraft = { name: null, blocks: {}, fixes: [], droppedQuotes: [] };

/** Что знает код о версии и паре: ключ, герои ключа и главы каждого (посчитано на шаге выбора). */
export interface WorldPairCheck {
  key: string;
  a: string;
  b: string;
  language: Language;
  chapters: ChapterIndex;
  chaptersA: ReadonlySet<number>;
  chaptersB: ReadonlySet<number>;
  glossary: readonly NameEntry[];
  /** Проверять ядро пары: при перегенерации одного блока - нет (ядра в таком ответе нет). */
  core: boolean;
}

/**
 * Ответ шага пары после кода (`F08-8e`): строка сравнения с главой стороны не из версии - выброшена
 * (`CHAPTER_UNKNOWN`); цитата с главой не версии или не дословная - выброшена с причиной
 * (`droppedQuotes`); цитата, у которой говорящий или тот, о ком она, - не герой пары или один и тот
 * же, - выброшена (`KEY_UNKNOWN`): импорт отбил бы пару целиком (`checkWorldPair`); списки - по
 * пределам импорта (Q7 `F08 | F08-4`).
 */
export function readPairAnswer(value: unknown, check: WorldPairCheck): WorldPairDraft {
  const v = rec(value);
  const fixes: WorldFix[] = [];
  const droppedQuotes: DroppedWorldQuote[] = [];
  const known = (n: number | null): n is number => chapterKnown(check.chapters, n);
  const blocks: WorldPairBlocks = {};
  for (const field of ['short', 'bonds', 'differences', 'conclusion'] as const) {
    const text = textOrNull(v[field]);
    if (text) blocks[field] = text;
  }

  const compare = list(v.compare).flatMap((raw, i) => {
    const c = rec(raw);
    const chapterA = chapterOf(c.chapterA);
    const chapterB = chapterOf(c.chapterB);
    if (!known(chapterA) || !known(chapterB)) {
      fixes.push(chapterFix(`compare.${i}`, known(chapterA) ? chapterB : chapterA));
      return [];
    }
    return [
      {
        feature: trimmed(c.feature),
        a: trimmed(c.a),
        chapterA,
        b: trimmed(c.b),
        chapterB,
      },
    ];
  });
  if (compare.length > 0) {
    blocks.compare = limited(compare, BOOK_WORLD_LIMITS.compare, 'compare', fixes);
  }

  const members = [check.a, check.b];
  const quotes = list(v.quotes).flatMap((raw, i) => {
    const q = rec(raw);
    const text = trimmed(q.text);
    const speakerKey = trimmed(q.speakerKey);
    const aboutKey = trimmed(q.aboutKey);
    if (!members.includes(speakerKey) || !members.includes(aboutKey) || speakerKey === aboutKey) {
      fixes.push({
        code: 'KEY_UNKNOWN',
        path: `quotes.${i}`,
        note: `a quote of the pair is said by one of ${check.a}, ${check.b} about the other: removed`,
      });
      return [];
    }
    const chapter = quoteChapterOrDrop(
      text,
      chapterOf(q.chapter),
      `quotes.${i}`,
      check,
      fixes,
      droppedQuotes,
    );
    if (chapter === null) return [];
    return [
      {
        text,
        chapter,
        speakerKey,
        aboutKey,
        interpretation: trimmed(q.interpretation),
      },
    ];
  });
  if (quotes.length > 0) blocks.quotes = limited(quotes, BOOK_WORLD_LIMITS.quotes, 'quotes', fixes);

  const faq = readFaq(v.faq, fixes);
  if (faq) blocks.faq = faq;

  return { name: nameOf(v.name), blocks, fixes, droppedQuotes };
}

function pairFields(blocks: WorldPairBlocks): TextField[] {
  const fields: TextField[] = [];
  const add = (path: string, text: string | null | undefined, long: boolean) => {
    if (typeof text === 'string' && text.trim() !== '') fields.push({ path, text, long });
  };
  add('short', blocks.short, true);
  (blocks.compare ?? []).forEach((c, i) => {
    add(`compare.${i}.feature`, c.feature, false);
    add(`compare.${i}.a`, c.a, true);
    add(`compare.${i}.b`, c.b, true);
  });
  add('bonds', blocks.bonds, true);
  add('differences', blocks.differences, true);
  add('conclusion', blocks.conclusion, true);
  (blocks.quotes ?? []).forEach((q, i) =>
    add(`quotes.${i}.interpretation`, q.interpretation, true),
  );
  (blocks.faq ?? []).forEach((f, i) => {
    add(`faq.${i}.question`, f.question, false);
    add(`faq.${i}.answer`, f.answer, true);
  });
  return fields;
}

/** Что дописать, чтобы собрать ядро пары: по части ядра `computeWorldCore`. */
const PAIR_CORE_NOTES: Partial<Record<WorldCorePart, string>> = {
  short: 'Write "short": it is the core of the page.',
  compare: `The core needs ${WORLD_PAIR_CORE.compare} full comparison rows: add features both characters share, each side with its chapter.`,
  conclusion: 'Write "conclusion": it is the core of the page.',
};

/**
 * Ядро пары в ответе (решение арбитра `F08 | F08-8e-1` Q5): правило ядра одно - `computeWorldCore`
 * (`book-world/world-core.ts`); общие главы ответ не несёт (их пишет пересчёт), поэтому присутствие
 * подставлено и в замечания не идёт. Нет части - замечание и одна переделка, затем запись как есть.
 */
export function pairCoreRemarks(blocks: WorldPairBlocks): DraftRemark[] {
  const core = computeWorldCore({
    type: 'pair',
    short: blocks.short ?? null,
    compare: blocks.compare ?? null,
    conclusion: blocks.conclusion ?? null,
    character: null,
    arc: null,
    quotes: null,
    scenes: null,
    mentions: { chapters: [1] },
  });
  return core.missing.flatMap((m) => {
    const note = PAIR_CORE_NOTES[m.part];
    return note ? [codeRemark('CORE_MISSING', m.part, note)] : [];
  });
}

/**
 * Сторона строки сравнения - в главе, где формы имени нашли своего героя (как сцены героя, `tech.md`
 * §5): иначе замечание и переделка.
 */
function pairSideRemarks(blocks: WorldPairBlocks, check: WorldPairCheck): DraftRemark[] {
  const outside = (path: string, who: string, chapter: number) =>
    codeRemark(
      'SCENE_OUTSIDE_MENTIONS',
      path,
      `${who} is not found by the name forms in chapter ${chapter}: take a scene from a chapter where the character is, or leave the feature out.`,
    );
  return (blocks.compare ?? []).flatMap((c, i) => [
    ...(check.chaptersA.has(c.chapterA)
      ? []
      : [outside(`compare.${i}.chapterA`, check.a, c.chapterA)]),
    ...(check.chaptersB.has(c.chapterB)
      ? []
      : [outside(`compare.${i}.chapterB`, check.b, c.chapterB)]),
  ]);
}

/** Замечания кода к паре: импорт, ядро, сторона вне глав своего героя, текст (язык, имена, мусор). */
export function pairRemarks(
  draft: WorldPairDraft,
  check: WorldPairCheck,
  name: string,
): DraftRemark[] {
  return [
    ...importRemarks(check.key, draft.name ?? name, draft.blocks, 'pair'),
    ...(check.core ? pairCoreRemarks(draft.blocks) : []),
    ...pairSideRemarks(draft.blocks, check),
    ...textRemarks(pairFields(draft.blocks), check.language, check.glossary),
  ];
}

// ---------------------------------------------------------------- страница места

/** Блоки страницы места (`F08-12b`; `PLACE_SHAPE`, без `aliases`: их пишет выбор). */
export interface WorldPlaceBlocks {
  short?: string;
  kind?: WorldPlaceKind;
  location?: string;
  significance?: string;
  description?: string;
  wikidataId?: string;
  scenes?: BookWorldSceneDto[];
  quotes?: BookWorldQuoteDto[];
  faq?: BookAnalysisFaqDto[];
  imageBrief?: string;
}

export interface WorldPlaceDraft {
  name: string | null;
  blocks: WorldPlaceBlocks;
  fixes: WorldFix[];
  droppedQuotes: DroppedWorldQuote[];
  /** Отпечаток «Описания», по которому написано ТЗ (`appearancePrint`); ТЗ нет — поля нет. */
  briefFor?: string | null;
}

export const EMPTY_PLACE: WorldPlaceDraft = {
  name: null,
  blocks: {},
  fixes: [],
  droppedQuotes: [],
};

/** Что знает код о версии и месте страницы. */
export interface WorldPlaceCheck {
  key: string;
  language: Language;
  chapters: ChapterIndex;
  /** Главы, где формы названия нашли место (посчитано на шаге выбора). */
  mentionChapters: ReadonlySet<number>;
  /** Ключи героев - говорящих цитаты места (`speakerKey` только на героя, `F08-12a`). */
  heroKeys: ReadonlySet<string>;
  glossary: readonly NameEntry[];
  /** «Описание» сохранённого места - только при перегенерации одного блока `imageBrief` (Q2). */
  storedDescription: string | null;
  briefRegen: boolean;
  /** Проверять ядро места: при перегенерации одного блока - нет. */
  core: boolean;
}

/**
 * Ответ шага места после кода (`F08-12b`): вид - только `real`/`fictional`, номер Wikidata - только
 * у реального и по форме `Q…` (иначе снят с `IMPORT_INVALID`: точку проверяет сервер при записи);
 * сцена с главой не версии - выброшена (`CHAPTER_UNKNOWN`); цитата - как у героя, говорящий не герой -
 * без `speakerKey` (`KEY_UNKNOWN`); ТЗ - только с «Описанием» (`BRIEF_WITHOUT_DESCRIPTION`, Q2).
 */
export function readPlaceAnswer(value: unknown, check: WorldPlaceCheck): WorldPlaceDraft {
  const v = rec(value);
  const fixes: WorldFix[] = [];
  const droppedQuotes: DroppedWorldQuote[] = [];
  const blocks: WorldPlaceBlocks = {};
  for (const field of ['short', 'location', 'significance', 'description'] as const) {
    const text = textOrNull(v[field]);
    if (text) blocks[field] = text;
  }
  const kind = textOrNull(v.kind);
  if (kind && (WORLD_PLACE_KINDS as readonly string[]).includes(kind)) {
    blocks.kind = kind as WorldPlaceKind;
  } else if (kind) {
    fixes.push({
      code: 'IMPORT_INVALID',
      path: 'kind',
      note: `"${kind}" is not real or fictional: removed`,
    });
  }
  const wikidataId = textOrNull(v.wikidataId);
  // Номер не по форме импорта (`WIKIDATA_ID_REGEX`, `WIKIDATA_ID_MAX`) снимается сам, а не отбивает весь
  // пункт `kind` импортом (/qa F08-12b круг 3).
  const idOk = (id: string) => WIKIDATA_ID_REGEX.test(id) && id.length <= WIKIDATA_ID_MAX;
  if (wikidataId && (!wikidataIdAllowed(blocks.kind) || !idOk(wikidataId))) {
    fixes.push({
      code: 'IMPORT_INVALID',
      path: 'wikidataId',
      note: `"${wikidataId}" is not a Wikidata item of a real place: removed`,
    });
  } else if (wikidataId) {
    blocks.wikidataId = wikidataId;
  }
  // ТЗ места - по «Описанию» (решение `F08 | F08-12b` Q2); при перегенерации одного ТЗ - по сохранённому.
  const imageBrief = textOrNull(v.imageBrief);
  const look = check.briefRegen
    ? check.storedDescription
    : briefBasisOf('place', { description: blocks.description ?? null });
  let briefFor: string | null | undefined;
  if (imageBrief && !look) {
    fixes.push({
      code: 'BRIEF_WITHOUT_DESCRIPTION',
      path: 'imageBrief',
      note: 'no description: the brief is removed',
    });
  } else if (imageBrief) {
    blocks.imageBrief = imageBrief;
    briefFor = appearancePrint(look);
  }

  const scenes = readScenes(v.scenes, check.chapters, fixes);
  if (scenes) blocks.scenes = scenes;

  const quotes = readSpeakerQuotes(
    v.quotes,
    check,
    (speaker) => check.heroKeys.has(speaker),
    'is not a character key',
    fixes,
    droppedQuotes,
  );
  if (quotes) blocks.quotes = quotes;

  const faq = readFaq(v.faq, fixes);
  if (faq) blocks.faq = faq;

  return {
    name: nameOf(v.name),
    blocks,
    fixes,
    droppedQuotes,
    ...(briefFor !== undefined ? { briefFor } : {}),
  };
}

function placeFields(blocks: WorldPlaceBlocks): TextField[] {
  const fields: TextField[] = [];
  const add = (path: string, text: string | null | undefined, long: boolean) => {
    if (typeof text === 'string' && text.trim() !== '') fields.push({ path, text, long });
  };
  add('short', blocks.short, true);
  add('location', blocks.location, false);
  add('significance', blocks.significance, true);
  add('description', blocks.description, true);
  (blocks.scenes ?? []).forEach((sc, i) => add(`scenes.${i}.text`, sc.text, true));
  (blocks.quotes ?? []).forEach((q, i) =>
    add(`quotes.${i}.interpretation`, q.interpretation, true),
  );
  (blocks.faq ?? []).forEach((f, i) => {
    add(`faq.${i}.question`, f.question, false);
    add(`faq.${i}.answer`, f.answer, true);
  });
  return fields;
}

/** Что дописать, чтобы собрать ядро места: по части ядра `computeWorldCore`. */
const PLACE_CORE_NOTES: Partial<Record<WorldCorePart, string>> = {
  short: 'Write "short": it is the core of the page.',
  kind: 'Write "kind" - "real" or "fictional": it is the core of the page.',
  significance: 'Write "significance": it is the core of the page.',
  scenes: `The core needs ${WORLD_PLACE_CORE.scenes} scenes in this place, each with its chapter.`,
};

/**
 * Ядро места в ответе: правило одно - `computeWorldCore`; присутствие ответ не несёт (его пишет
 * пересчёт), поэтому подставлено и в замечания не идёт. Нет части - замечание и одна переделка.
 */
export function placeCoreRemarks(blocks: WorldPlaceBlocks): DraftRemark[] {
  const core = computeWorldCore({
    type: 'place',
    short: blocks.short ?? null,
    kind: blocks.kind ?? null,
    significance: blocks.significance ?? null,
    scenes: blocks.scenes ?? null,
    character: null,
    arc: null,
    quotes: null,
    mentions: { chapters: [1] },
  });
  return core.missing.flatMap((m) => {
    const note = PLACE_CORE_NOTES[m.part];
    return note ? [codeRemark('CORE_MISSING', m.part, note)] : [];
  });
}

/**
 * Замечания кода к месту: импорт, ядро, сцена вне глав места (то же правило, что у героя), текст
 * (язык, имена, мусор).
 */
export function placeRemarks(
  draft: WorldPlaceDraft,
  check: WorldPlaceCheck,
  name: string,
): DraftRemark[] {
  return [
    ...importRemarks(check.key, draft.name ?? name, draft.blocks, 'place'),
    ...(check.core ? placeCoreRemarks(draft.blocks) : []),
    ...mentionRemarks({ scenes: draft.blocks.scenes }, check.mentionChapters, 'place'),
    ...textRemarks(placeFields(draft.blocks), check.language, check.glossary),
  ];
}

// ---------------------------------------------------------------- страница предмета и понятия

/**
 * Блоки страницы предмета и понятия (`F08-13b`; поля по типу - решение арбитра `F08 | F08-13` Q1):
 * у понятия только `short`, `significance`, `quotes`; ТЗ на иллюстрацию нет ни у одного (Q4).
 */
export interface WorldObjectBlocks {
  short?: string;
  significance?: string;
  description?: string;
  quotes?: BookWorldQuoteDto[];
  faq?: BookAnalysisFaqDto[];
  characterKeys?: string[];
  themeKeys?: string[];
}

export interface WorldObjectDraft {
  name: string | null;
  blocks: WorldObjectBlocks;
  fixes: WorldFix[];
  droppedQuotes: DroppedWorldQuote[];
}

export const EMPTY_OBJECT: WorldObjectDraft = {
  name: null,
  blocks: {},
  fixes: [],
  droppedQuotes: [],
};

/** Что знает код о версии и предмете (понятии) страницы. */
export interface WorldObjectCheck {
  key: string;
  type: WorldRunObjectType;
  language: Language;
  chapters: ChapterIndex;
  /** Ключи героев - говорящих цитаты (`speakerKey` только на героя, как у места). */
  heroKeys: ReadonlySet<string>;
  /**
   * Ключи героев мира версии на момент шага - `characterKeys` (правило записи `checkWorldRefs`: связь
   * только с героем мира, решение `F08 | F08-13b` Q5).
   */
  worldHeroKeys: ReadonlySet<string>;
  /** Ключи тем анализа версии на момент шага - `themeKeys` (`checkThemeKeys`, Q5). */
  themeKeys: ReadonlySet<string>;
  glossary: readonly NameEntry[];
  /** Проверять ядро: при перегенерации одного блока - нет. */
  core: boolean;
}

/**
 * Список ключей связи ответа (`characterKeys`, `themeKeys`): ключ не из `known` или повтор - снят
 * (`KEY_UNKNOWN`), хвост сверх предела импорта - отрезан. Так запись не отбивается 400 на платном шаге
 * (`checkWorldRefs`, `checkThemeKeys`; решение арбитра `F08 | F08-13b` Q5).
 */
function readKeyList(
  raws: unknown,
  path: 'characterKeys' | 'themeKeys',
  known: ReadonlySet<string>,
  note: string,
  fixes: WorldFix[],
): string[] | undefined {
  const keys: string[] = [];
  list(raws).forEach((raw, i) => {
    const key = trimmed(raw);
    if (key === '' || keys.includes(key)) return;
    if (!known.has(key)) {
      fixes.push({ code: 'KEY_UNKNOWN', path: `${path}.${i}`, note: `"${key}" ${note}: removed` });
      return;
    }
    keys.push(key);
  });
  return keys.length > 0 ? limited(keys, BOOK_WORLD_LIMITS[path], path, fixes) : undefined;
}

/**
 * Ответ шага предмета или понятия после кода (`F08-13b`): только поля своего типа - перечень один,
 * `WORLD_BLOCKS_OF_TYPE` (`worldTypeHasBlock`, решение арбитра `F08 | F08-13b` R1; понятие - `short`,
 * `significance`, `quotes`), `short` - колонка у всех типов; цитата - как у места, говорящий не
 * герой - без `speakerKey`; герои и темы предмета - только сохранённые герои мира и темы анализа
 * версии, чужие ключи сняты (`KEY_UNKNOWN`).
 */
export function readObjectAnswer(value: unknown, check: WorldObjectCheck): WorldObjectDraft {
  const v = rec(value);
  const fixes: WorldFix[] = [];
  const droppedQuotes: DroppedWorldQuote[] = [];
  const blocks: WorldObjectBlocks = {};
  const own = (block: keyof WorldObjectBlocks): boolean =>
    block === 'short' || worldTypeHasBlock(check.type, block);
  for (const field of ['short', 'significance', 'description'] as const) {
    const text = own(field) ? textOrNull(v[field]) : null;
    if (text) blocks[field] = text;
  }
  const quotes = own('quotes')
    ? readSpeakerQuotes(
        v.quotes,
        check,
        (speaker) => check.heroKeys.has(speaker),
        'is not a character key',
        fixes,
        droppedQuotes,
      )
    : undefined;
  if (quotes) blocks.quotes = quotes;
  const faq = own('faq') ? readFaq(v.faq, fixes) : undefined;
  if (faq) blocks.faq = faq;
  const characterKeys = own('characterKeys')
    ? readKeyList(
        v.characterKeys,
        'characterKeys',
        check.worldHeroKeys,
        'is not a character of this world',
        fixes,
      )
    : undefined;
  if (characterKeys) blocks.characterKeys = characterKeys;
  const themeKeys = own('themeKeys')
    ? readKeyList(
        v.themeKeys,
        'themeKeys',
        check.themeKeys,
        'is not a theme of the analysis of this version',
        fixes,
      )
    : undefined;
  if (themeKeys) blocks.themeKeys = themeKeys;
  return { name: nameOf(v.name), blocks, fixes, droppedQuotes };
}

function objectFields(blocks: WorldObjectBlocks): TextField[] {
  const fields: TextField[] = [];
  const add = (path: string, text: string | null | undefined, long: boolean) => {
    if (typeof text === 'string' && text.trim() !== '') fields.push({ path, text, long });
  };
  add('short', blocks.short, true);
  add('significance', blocks.significance, true);
  add('description', blocks.description, true);
  (blocks.quotes ?? []).forEach((q, i) =>
    add(`quotes.${i}.interpretation`, q.interpretation, true),
  );
  (blocks.faq ?? []).forEach((f, i) => {
    add(`faq.${i}.question`, f.question, false);
    add(`faq.${i}.answer`, f.answer, true);
  });
  return fields;
}

/** Что дописать, чтобы собрать ядро предмета (понятия): по части ядра `computeWorldCore`. */
const OBJECT_CORE_NOTES: Record<WorldRunObjectType, Partial<Record<WorldCorePart, string>>> = {
  object: {
    short: 'Write "short": it is the core of the page.',
    significance: 'Write "significance": it is the core of the page.',
  },
  term: {
    short: 'Write "short" - the glossary definition of the term: it is the core of the page.',
  },
};

/**
 * Ядро предмета (понятия) в ответе: правило одно - `computeWorldCore`; присутствие ответ не несёт (его
 * пишет пересчёт), поэтому подставлено и в замечания не идёт. Нет части - замечание и одна переделка.
 */
function objectCoreRemarks(type: WorldRunObjectType, blocks: WorldObjectBlocks): DraftRemark[] {
  const core = computeWorldCore({
    type,
    short: blocks.short ?? null,
    significance: blocks.significance ?? null,
    character: null,
    arc: null,
    quotes: null,
    scenes: null,
    mentions: { chapters: [1] },
  });
  return core.missing.flatMap((m) => {
    const note = OBJECT_CORE_NOTES[type][m.part];
    return note ? [codeRemark('CORE_MISSING', m.part, note)] : [];
  });
}

/** Замечания кода к предмету (понятию): импорт по своему типу, ядро, текст (язык, имена, мусор). */
export function objectRemarks(
  draft: WorldObjectDraft,
  check: WorldObjectCheck,
  name: string,
): DraftRemark[] {
  return [
    ...importRemarks(check.key, draft.name ?? name, draft.blocks, check.type),
    ...(check.core ? objectCoreRemarks(check.type, draft.blocks) : []),
    ...textRemarks(objectFields(draft.blocks), check.language, check.glossary),
  ];
}

// ---------------------------------------------------------------- внешние блоки

export interface WorldExternalBlocks {
  critique?: string;
  prototypes?: string;
  adaptations?: BookWorldAdaptationDto[];
}

/** Ответ внешнего шага: блоки, ссылки утверждений на источники ответа и сами источники. */
export interface WorldExternalDraft {
  blocks: WorldExternalBlocks;
  /** Индексы `sources` по утверждению: у текстов - блок, у экранизаций - элемент. */
  refs: { critique: number[]; prototypes: number[]; adaptations: number[][] };
  sources: WorldSource[];
  fixes: WorldFix[];
}

export const EMPTY_EXTERNAL: WorldExternalDraft = {
  blocks: {},
  refs: { critique: [], prototypes: [], adaptations: [] },
  sources: [],
  fixes: [],
};

export function readExternalAnswer(value: unknown): WorldExternalDraft {
  const v = rec(value);
  const fixes: WorldFix[] = [];
  // Источник не той формы (не https, пустое или длинное название) выбрасывается до ссылок; ссылки
  // утверждений - номера ответа модели, поэтому они пересчитываются в номера оставшихся источников.
  const at = new Map<number, number>();
  const valid: WorldSource[] = [];
  list(v.sources).forEach((raw, i) => {
    const s = rec(raw);
    const source = { title: trimmed(s.title), url: trimmed(s.url) };
    const errors = validateSync(plainToInstance(BookAnalysisSourceDto, source));
    if (errors.length > 0) {
      fixes.push({
        code: 'IMPORT_INVALID',
        path: `sources.${i}`,
        note: 'not an absolute https address with a title in the import limit: removed',
      });
      return;
    }
    at.set(i, valid.length);
    valid.push(source);
  });
  const sources = limited(valid, BOOK_WORLD_LIMITS.sources, 'sources', fixes);
  const n = sources.length;
  const refsOf = (refs: unknown): number[] => [
    ...new Set(
      list(refs).flatMap((r) => {
        const k = Number.isInteger(r) ? at.get(r as number) : undefined;
        return k !== undefined && k < n ? [k] : [];
      }),
    ),
  ];
  const blocks: WorldExternalBlocks = {};
  const refs: WorldExternalDraft['refs'] = { critique: [], prototypes: [], adaptations: [] };
  for (const block of ['critique', 'prototypes'] as const) {
    const t = rec(v[block]);
    const text = textOrNull(t.text);
    if (text) {
      blocks[block] = text;
      refs[block] = refsOf(t.refs);
    }
  }
  const adaptations = list(v.adaptations).map((raw) => {
    const a = rec(raw);
    // Строгая форма требует число: «года нет» модель пишет `0`.
    const year = Number.isInteger(a.year) && (a.year as number) > 0 ? (a.year as number) : null;
    const actor = textOrNull(a.actor);
    return {
      value: {
        title: trimmed(a.title),
        ...(year !== null ? { year } : {}),
        ...(actor ? { actor } : {}),
        differences: trimmed(a.differences),
      },
      refs: refsOf(a.refs),
    };
  });
  const kept = limited(adaptations, BOOK_WORLD_LIMITS.adaptations, 'adaptations', fixes);
  if (kept.length > 0) {
    blocks.adaptations = kept.map((a) => a.value);
    refs.adaptations = kept.map((a) => a.refs);
  }
  return { blocks, refs, sources, fixes };
}

/** Замечания кода к внешним блокам: импорт (с источниками) и текст. */
export function externalRemarks(
  draft: WorldExternalDraft,
  key: string,
  name: string,
  language: Language,
  glossary: readonly NameEntry[],
): DraftRemark[] {
  const fields: TextField[] = [];
  if (draft.blocks.critique)
    fields.push({ path: 'critique', text: draft.blocks.critique, long: true });
  if (draft.blocks.prototypes) {
    fields.push({ path: 'prototypes', text: draft.blocks.prototypes, long: true });
  }
  (draft.blocks.adaptations ?? []).forEach((a, i) =>
    fields.push({ path: `adaptations.${i}.differences`, text: a.differences, long: true }),
  );
  const body = { ...draft.blocks, ...(draft.sources.length > 0 ? { sources: draft.sources } : {}) };
  return [...importRemarks(key, name, body), ...textRemarks(fields, language, glossary)];
}

/** Итог проверки внешних блоков источниками. */
export interface WorldExternalVerdict {
  blocks: WorldExternalBlocks;
  /** Проверенные источники каждого записываемого блока. */
  sourcesOf: Partial<Record<WorldExternalBlock, WorldSource[]>>;
  /** Блоки, которые проверка сняла целиком. */
  unverified: WorldExternalBlock[];
  fixes: WorldFix[];
  droppedSources: DroppedWorldSource[];
  /**
   * Номер в `sources` ответа у каждого снятого источника - поэлементно с `droppedSources`. Только
   * внутри хода (выборка снятых источников перегенерированного блока), в контракт не выходит.
   */
  droppedAt: number[];
}

/**
 * Внешние блоки - только с источником, который открыл фетчер и где есть название книги или имя
 * автора (`F07` U3, `tech.md` §5). Утверждение без такого источника снимается: текст блока - целиком,
 * экранизация - элементом; блок без единого утверждения не пишется (`unverified`).
 */
export function verifyWorldExternal(
  key: string,
  draft: WorldExternalDraft,
  checks: readonly PageCheck[],
  titles: readonly string[],
  authors: readonly string[],
): WorldExternalVerdict {
  const fixes: WorldFix[] = [];
  const droppedSources: DroppedWorldSource[] = [];
  const droppedAt: number[] = [];
  const good = draft.sources.map((source, i) => {
    const check = checks[i];
    if (!check?.opened) {
      droppedSources.push({
        key,
        title: source.title,
        host: check?.host || hostOf(source.url),
        reason: 'SOURCE_UNREACHABLE',
      });
      droppedAt.push(i);
      fixes.push({
        code: 'SOURCE_UNREACHABLE',
        path: `sources.${i}`,
        note: 'the page did not open',
      });
      return false;
    }
    if (!pageIsAbout(check.text, titles, authors)) {
      droppedSources.push({
        key,
        title: source.title,
        host: check.host,
        reason: 'SOURCE_UNRELATED',
      });
      droppedAt.push(i);
      fixes.push({
        code: 'SOURCE_UNRELATED',
        path: `sources.${i}`,
        note: 'the page names neither the book nor its author',
      });
      return false;
    }
    return true;
  });
  const verified = (refs: readonly number[]) => refs.filter((i) => good[i]);
  const blocks: WorldExternalBlocks = {};
  const sourcesOf: WorldExternalVerdict['sourcesOf'] = {};
  const unverified: WorldExternalBlock[] = [];
  const unverifiedFix = (path: string) =>
    fixes.push({
      code: 'SOURCE_UNVERIFIED',
      path,
      note: 'no source of this statement opened and named the book or its author: removed',
    });
  const sourcesAt = (indexes: readonly number[]) =>
    [...new Set(indexes)].sort((a, b) => a - b).map((i) => draft.sources[i]);
  for (const block of ['critique', 'prototypes'] as const) {
    const text = draft.blocks[block];
    if (!text) continue;
    const refs = verified(draft.refs[block]);
    if (refs.length === 0) {
      unverifiedFix(block);
      unverified.push(block);
      continue;
    }
    blocks[block] = text;
    sourcesOf[block] = sourcesAt(refs);
  }
  if (draft.blocks.adaptations) {
    const kept: BookWorldAdaptationDto[] = [];
    const used: number[] = [];
    draft.blocks.adaptations.forEach((a, i) => {
      const refs = verified(draft.refs.adaptations[i] ?? []);
      if (refs.length === 0) {
        unverifiedFix(`adaptations.${i}`);
        return;
      }
      kept.push(a);
      used.push(...refs);
    });
    if (kept.length > 0) {
      blocks.adaptations = kept;
      sourcesOf.adaptations = sourcesAt(used);
    } else unverified.push('adaptations');
  }
  return { blocks, sourcesOf, unverified, fixes, droppedSources, droppedAt };
}

/** Все записанные внешние блоки несут флаг: даты и имена сверяет человек (`product.md` §5). */
export const externalChecks = (blocks: WorldExternalBlocks): DraftRemark[] =>
  (Object.keys(blocks) as WorldExternalBlock[]).map((block) =>
    codeRemark(
      'EXTERNAL_CHECK',
      block,
      'An external statement with a checked source: check the dates, names and facts by the source.',
    ),
  );
