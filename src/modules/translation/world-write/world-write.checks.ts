import { Language } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import type {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
} from '../../book-world/dto/book-world-blocks.dto';
import { BookWorldEntityInputDto } from '../../book-world/dto/update-book-world.dto';
import { countInParagraph, foldMention, mentionForms } from '../../book-world/world-mentions';
import { quoteStandsIn } from '../../book-world/world-quote-check';
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
  WorldExternalBlock,
  WorldFix,
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
  fixes: WorldFix[];
}

export const EMPTY_SELECT: WorldSelectDraft = { characters: [], fixes: [] };

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
): WorldSelectDraft {
  const fixes: WorldFix[] = [];
  const known = new Map(candidates.map((c) => [c.key, c]));
  const characters: WorldSelectDraft['characters'] = [];
  list(rec(value).characters).forEach((raw, i) => {
    const c = rec(raw);
    const key = trimmed(c.key);
    const candidate = known.get(key);
    if (!candidate || characters.some((x) => x.key === key)) {
      fixes.push({
        code: 'KEY_UNKNOWN',
        path: `characters.${i}`,
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
          path: `characters.${i}.aliases.${j}`,
          note: `longer than ${BOOK_WORLD_LIMITS.name} characters: removed`,
        });
        return;
      }
      if (!formInText(text, folded)) {
        fixes.push({
          code: 'ALIAS_NOT_IN_TEXT',
          path: `characters.${i}.aliases.${j}`,
          note: `"${text}" is not in the text of this version as a whole word: removed`,
        });
        return;
      }
      aliases.push(text);
    });
    characters.push({
      key,
      name: nameOf(c.name) ?? candidate.name,
      aliases: limited(aliases, BOOK_WORLD_LIMITS.aliases, `characters.${i}.aliases`, fixes),
    });
  });
  return { characters, fixes };
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
}

export interface WorldPageDraft {
  name: string | null;
  blocks: WorldPageBlocks;
  fixes: WorldFix[];
  droppedQuotes: DroppedWorldQuote[];
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
  const known = (n: number | null) => n !== null && check.chapters.has(n);
  const blocks: WorldPageBlocks = {};

  const short = textOrNull(v.short);
  if (short) blocks.short = short;
  const appearance = textOrNull(v.appearance);
  if (appearance) blocks.appearance = appearance;
  const character = textOrNull(v.character);
  if (character) blocks.character = character;
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
      return [{ title: trimmed(s.title), text: trimmed(s.text), chapter: chapter as number }];
    });
    blocks.arc = {
      from: trimmed(arc.from),
      to: trimmed(arc.to),
      ...(stages.length > 0
        ? { stages: limited(stages, BOOK_WORLD_LIMITS.stages, 'arc.stages', fixes) }
        : {}),
    };
  }

  const scenes = list(v.scenes).flatMap((raw, i) => {
    const s = rec(raw);
    const chapter = chapterOf(s.chapter);
    if (!known(chapter)) {
      fixes.push(chapterFix(`scenes.${i}`, chapter));
      return [];
    }
    return [{ chapter: chapter as number, title: trimmed(s.title), text: trimmed(s.text) }];
  });
  if (scenes.length > 0) blocks.scenes = limited(scenes, BOOK_WORLD_LIMITS.scenes, 'scenes', fixes);

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

  const quotes = list(v.quotes).flatMap((raw, i) => {
    const q = rec(raw);
    const text = trimmed(q.text);
    const chapter = chapterOf(q.chapter);
    if (!known(chapter)) {
      droppedQuotes.push({ key: check.key, chapter, text, reason: 'CHAPTER_UNKNOWN' });
      fixes.push(chapterFix(`quotes.${i}`, chapter));
      return [];
    }
    if (!quoteStandsIn(text, check.chapters.get(chapter as number) ?? [])) {
      droppedQuotes.push({ key: check.key, chapter, text, reason: 'QUOTE_NOT_VERBATIM' });
      fixes.push({
        code: 'QUOTE_NOT_VERBATIM',
        path: `quotes.${i}`,
        note: `not word for word in chapter ${chapter}: removed`,
      });
      return [];
    }
    const speaker = trimmed(q.speakerKey);
    let speakerKey: string | undefined;
    if (speaker !== '') {
      if (check.refKeys.has(speaker) || speaker === check.key) speakerKey = speaker;
      else {
        fixes.push({
          code: 'KEY_UNKNOWN',
          path: `quotes.${i}.speakerKey`,
          note: `"${speaker}" is not a known key: the speaker is left out`,
        });
      }
    }
    return [
      {
        text,
        chapter: chapter as number,
        ...(speakerKey ? { speakerKey } : {}),
        interpretation: trimmed(q.interpretation),
      },
    ];
  });
  if (quotes.length > 0) blocks.quotes = limited(quotes, BOOK_WORLD_LIMITS.quotes, 'quotes', fixes);

  const faq = list(v.faq).map((raw) => {
    const f = rec(raw);
    return { question: trimmed(f.question), answer: trimmed(f.answer) };
  });
  if (faq.length > 0) blocks.faq = limited(faq, BOOK_WORLD_LIMITS.faq, 'faq', fixes);

  return { name: nameOf(v.name), blocks, fixes, droppedQuotes };
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
export function importRemarks(key: string, name: string, blocks: object): DraftRemark[] {
  const own = new Set(Object.keys(blocks));
  const dto = plainToInstance(BookWorldEntityInputDto, {
    key,
    type: 'character',
    name,
    role: 'main',
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
): DraftRemark[] {
  const outside = (path: string, chapter: number) =>
    codeRemark(
      'SCENE_OUTSIDE_MENTIONS',
      path,
      `The character is not found by the name forms in chapter ${chapter}: take a scene from a chapter where the character is, or leave it out.`,
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
