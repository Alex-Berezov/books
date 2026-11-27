import { isFilled } from '../book-analysis/book-analysis-core';
import { isRecord } from '../../shared/prisma/json-record.util';
import {
  BOOK_WORLD_BLOCK_KEYS,
  WORLD_BLOCKS_OF_TYPE,
  coPresenceWith,
  readStoredBlocks,
  type StoredWorldEntity,
} from './book-world-data';
import type { Prisma } from '@prisma/client';
import {
  BOOK_WORLD_KEY_REGEX,
  BOOK_WORLD_LIMITS,
  isWorldObjectType,
  type BookWorldImportType,
} from './dto/book-world-blocks.dto';
import { mentionChapters } from './world-core';

/** Разделитель ключей героев в ключе пары `{a}--{b}` — одно место правила на books. */
export const WORLD_PAIR_SEPARATOR = '--';

/** В ключе стоит разделитель пары: у героя это ключ вида пары (`LEGACY-507`). */
export const hasPairSeparator = (key: string): boolean => key.includes(WORLD_PAIR_SEPARATOR);

/**
 * Ключ пары `{a}--{b}` → ключи героев (`F08-8c`, решение арбитра Q1): ровно одно `--`, обе половины
 * не пусты; иначе `null`. Единственный разбор ключа пары в books; проверки ключа — `checkWorldPair`.
 * Копия разбора живёт на фронте — `books-front/lib/book-world/pair.ts` (`pairMembers`); менять вместе.
 */
export function pairMembers(key: string): [string, string] | null {
  const at = key.indexOf(WORLD_PAIR_SEPARATOR);
  if (at <= 0 || at !== key.lastIndexOf(WORLD_PAIR_SEPARATOR)) return null;
  const a = key.slice(0, at);
  const b = key.slice(at + WORLD_PAIR_SEPARATOR.length);
  return b === '' ? null : [a, b];
}

/**
 * Ошибка формы ключа пары (`F08-8c`, решение арбитра Q1) — одно правило на запись (`checkWorldPair`)
 * и на сборку ключа ходом (`worldPairKey`): ровно одно `--`, обе половины не пусты, ключ в пределе
 * `BOOK_WORLD_KEY_REGEX`, герои разные и по алфавиту по коду символа (`a < b` строк JS, без локали).
 * Порядок и различие героев скопированы на фронт — `books-front/lib/book-world/pair.ts`
 * (`pairKey`, `canonicalPairMembers`); менять вместе. Ключ годится — `members` и `error: null`;
 * ключ не разобрать на героев — `members: null`.
 */
function pairKeyCheck(key: string): { members: [string, string] | null; error: string | null } {
  const members = pairMembers(key);
  if (!members || !BOOK_WORLD_KEY_REGEX.test(key)) {
    return {
      members: null,
      error: 'a pair key is {a}--{b}: two character keys joined by one "--"',
    };
  }
  const [a, b] = members;
  if (a === b) return { members, error: 'a pair needs two different characters' };
  if (a > b) return { members, error: `pair keys go in alphabetical order: "${b}--${a}"` };
  return { members, error: null };
}

/**
 * Ключ пары героев `a` и `b` (`F08-8e`): герои по алфавиту через разделитель, если ключ проходит
 * правило формы `pairKeyCheck`; иначе `null` — пары у этих героев нет (решение арбитра `F08 | F08-8c`
 * Q1: герой с длинным ключом, с `--` или с `-` на стыке пары не получает).
 */
export function worldPairKey(a: string, b: string): string | null {
  const [first, second] = a < b ? [a, b] : [b, a];
  const key = `${first}${WORLD_PAIR_SEPARATOR}${second}`;
  const check = pairKeyCheck(key);
  return check.members?.[0] === first && check.error === null ? key : null;
}

/**
 * Номер Wikidata у места - только у реального (`F08-12a`, решение `F08 | F08-12` Q1): одно правило на
 * запись мира (`checkWorldTypeFields`) и разбор ответа шага места (`readPlaceAnswer`, R4 `F08 | F08-12b`).
 */
export const wikidataIdAllowed = (kind: string | null | undefined): boolean => kind === 'real';

/**
 * Ключ героя вида пары (`LEGACY-507`): `--` в ключе `character` занимает адрес пары. Отказ — только
 * новой строке героя или смене типа на `character` (решение арбитра `F08 | F08-8e-1` Q7, образец R1):
 * заведённого героя с `--` правят свободно, ключи не меняются (тема владельца №3).
 */
export function checkCharacterKey(
  entity: Pick<StoredWorldEntity, 'key' | 'type'>,
  storedType: string | null,
): WorldRefError[] {
  if (entity.type !== 'character') return [];
  return characterKeyRefused(entity.key, storedType)
    ? [{ path: 'key', message: 'a character key cannot hold "--": it is the form of a pair key' }]
    : [];
}

/**
 * Запись героя с этим ключом отбивается (`checkCharacterKey`): ключ вида пары у строки, которая ещё
 * не герой (`storedType` — тип сохранённой строки, `null` — строки нет). Тем же правилом ход мира
 * не берёт такого героя в кандидаты (`F08-8e-1` Q7: не платить за страницу под отказ записи).
 */
export const characterKeyRefused = (key: string, storedType: string | null): boolean =>
  storedType !== 'character' && hasPairSeparator(key);

/**
 * Герои ключа пары, которых нет героями версии — одно правило на запись (`checkWorldPair`) и на шаг
 * пары хода мира (без них пара не пишется).
 */
export const missingPairMembers = (
  members: readonly string[],
  characterKeys: ReadonlySet<string>,
): string[] => [...new Set(members)].filter((k) => !characterKeys.has(k));

/**
 * Ключ пары занят сущностью другого типа — правило хода мира (отбор пар и шаг пары): пару туда ход
 * не пишет. Запись такой ключ сама не отбивает: для неё это смена типа сущности (`checkWorldPair`
 * не зовёт это правило; героя под парами сменить тип не даёт `pairsHolding`).
 */
export const pairKeyTaken = (storedType: string | null | undefined): boolean =>
  storedType !== null && storedType !== undefined && storedType !== 'pair';

/**
 * Сохранённое присутствие героев (`mentions`) — вход условия заведения `pairEvidenceOf`; одно чтение
 * на запись мира и на шаг пары хода (присутствие пишет только пересчёт, R2).
 */
export async function savedMentionsOf(
  client: Pick<Prisma.TransactionClient, 'bookWorldEntity'>,
  bookVersionId: string,
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  if (keys.length === 0) return new Map();
  const rows = await client.bookWorldEntity.findMany({
    where: { bookVersionId, key: { in: [...new Set(keys)] } },
    select: { key: true, mentions: true },
    take: BOOK_WORLD_LIMITS.entities,
  });
  return new Map<string, unknown>(rows.map((r) => [r.key, r.mentions] as const));
}

/** Ошибка ссылки или ключа: путь поля внутри сущности (`relations.0.to`) или тела (`entities.1.key`). */
export interface WorldRefError {
  path: string;
  message: string;
}

export interface WorldRefContext {
  /** Ключи героев анализа этой версии (`BookAnalysis.characters[].key`). */
  analysisKeys: ReadonlySet<string>;
  /** Ключи сущностей версии после записи: сохранённые плюс пришедшие в теле. */
  entityKeys: ReadonlySet<string>;
  /** Ключи героев (`character`) версии после записи — члены пары только из них (`F08-8c`). */
  characterKeys: ReadonlySet<string>;
}

/**
 * Темы предмета (`F08-13a`, решение арбитра `F08 | F08-13a` R1): 400 — только ключам, пришедшим
 * в теле записи (`themeKeys` входа), которых нет ни среди тем анализа версии (`themeKeys`), ни среди
 * уже сохранённых у сущности (`stored`). Сохранённые ключи заново не сверяются: пересоздание анализа
 * без темы не запирает предмет от правки, и форма, вернувшая ключи из GET, сохраняется (анализ мир
 * не проверяет); читателю устаревший ключ не уходит (`toEntityDto`). Нет поля в теле — `[]`.
 */
export function checkThemeKeys(
  incoming: readonly string[] | null | undefined,
  stored: readonly string[] | null | undefined,
  themeKeys: ReadonlySet<string>,
): WorldRefError[] {
  const kept = new Set(stored ?? []);
  return (incoming ?? []).flatMap((key, j) =>
    themeKeys.has(key) || kept.has(key)
      ? []
      : [
          {
            path: `themeKeys.${j}`,
            message: `"${key}" is not a theme of the analysis of this version`,
          },
        ],
  );
}

/**
 * Ссылки на **слитой** сущности героя (как `checkAnalysisRefs`): `relations[].to` и
 * `quotes[].speakerKey` — ключ героя мира или героя анализа (ключ мира не обязан совпадать с
 * анализом, решение арбитра `F08 | F08-1` R7), не пары; связь с собой — отказ. Внешние блоки
 * (`critique`, `prototypes`, `adaptations`) — только при `sources` (`tech.md` §3). У пары проверок
 * нет вовсе: ключ, цитаты и состав — `checkWorldPair`, чужие поля (в том числе внешние блоки и
 * `sources`) — `checkWorldTypeFields`, по одной ошибке на поле. Связи предмета и события
 * (`F08-13a`, решение арбитра `F08 | F08-13` Q1): `characterKeys` — только герои мира (ключ героя
 * анализа без героя мира не годится: связь ведёт на страницу героя). `themeKeys` — `checkThemeKeys`.
 */
export function checkWorldRefs(entity: StoredWorldEntity, ctx: WorldRefContext): WorldRefError[] {
  if (entity.type === 'pair') return [];
  const errors: WorldRefError[] = [];
  // Ссылки героя — на героя мира или анализа (`tech.md` §3), не на пару (`F08-8c`): ключ пары —
  // тоже ключ сущности версии, но страница сравнения не адресат отношения или реплики.
  const known = (key: string) => ctx.characterKeys.has(key) || ctx.analysisKeys.has(key);

  for (const ref of worldEntityRefs(entity)) {
    if (ref.kind === 'character') {
      if (!ctx.characterKeys.has(ref.key)) {
        errors.push({
          path: ref.path,
          message: `"${ref.key}" is not a character of this world`,
        });
      }
    } else if (ref.kind === 'relation' && ref.key === entity.key) {
      errors.push({ path: ref.path, message: 'an entity cannot relate to itself' });
    } else if (!known(ref.key)) {
      errors.push({ path: ref.path, message: `unknown entity or character key "${ref.key}"` });
    }
  }

  if ((entity.sources ?? []).length === 0) {
    if (isFilled(entity.critique)) {
      errors.push({ path: 'critique', message: 'critique needs sources' });
    }
    if (isFilled(entity.prototypes)) {
      errors.push({ path: 'prototypes', message: 'prototypes need sources' });
    }
    if ((entity.adaptations ?? []).length > 0) {
      errors.push({ path: 'adaptations', message: 'adaptations need sources' });
    }
  }
  return errors;
}

type WorldRefKind = 'relation' | 'speaker' | 'about' | 'member' | 'character';

/**
 * Поля-ссылки сущности на ключи — один перечень на проверку ссылок и на отказ удаления
 * (`WORLD_ENTITY_REFERENCED`): `relations[].to`, `quotes[].speakerKey`, `quotes[].aboutKey`,
 * герои ключа пары (`member`, `F08-8c`: героя из-под пары не удалить) и герои предмета и события
 * (`characterKeys[]`, `F08-13a`). Темы анализа (`themeKeys`) — не ключи мира, их здесь нет.
 */
export function worldEntityRefs(
  entity: Pick<StoredWorldEntity, 'relations' | 'quotes'> &
    Partial<Pick<StoredWorldEntity, 'key' | 'type' | 'characterKeys'>>,
): { kind: WorldRefKind; path: string; key: string }[] {
  const refs: { kind: WorldRefKind; path: string; key: string }[] = [];
  const members = entity.type === 'pair' && entity.key ? pairMembers(entity.key) : null;
  for (const key of members ?? []) refs.push({ kind: 'member', path: 'key', key });
  // Колонка читается как есть (`readStoredBlocks`): не массив или не строка — не ссылка.
  (Array.isArray(entity.characterKeys) ? entity.characterKeys : []).forEach((key, j) => {
    if (typeof key === 'string' && key !== '') {
      refs.push({ kind: 'character', path: `characterKeys.${j}`, key });
    }
  });
  (entity.relations ?? []).forEach((r, j) => {
    if (typeof r.to === 'string')
      refs.push({ kind: 'relation', path: `relations.${j}.to`, key: r.to });
  });
  (entity.quotes ?? []).forEach((q, j) => {
    if (typeof q.speakerKey === 'string' && q.speakerKey !== '') {
      refs.push({ kind: 'speaker', path: `quotes.${j}.speakerKey`, key: q.speakerKey });
    }
    if (typeof q.aboutKey === 'string' && q.aboutKey !== '') {
      refs.push({ kind: 'about', path: `quotes.${j}.aboutKey`, key: q.aboutKey });
    }
  });
  return refs;
}

const hasValue = (v: unknown) => v !== null && v !== undefined;

/**
 * Поля не своего типа: у каждого типа — свой перечень блоков (`WORLD_BLOCKS_OF_TYPE`,
 * `book-world-data.ts`), остальные — 400 с путём поля, по одной ошибке на поле. У пары (`F08-8c`)
 * нет роли, форм имени (решение арбитра Q6: её имя не ищется в тексте) и источников (внешних блоков
 * у пары нет, `product.md` §6, Q2). У места (`F08-12a`, решение арбитра `F08 | F08-12` Q1) нет роли
 * и источников; `wikidataId` — только у реального места. У предмета, понятия и события (`F08-13a`,
 * решение арбитра `F08 | F08-13` Q1) нет роли и источников. `quotes[].aboutKey` — только у пары.
 * `exclusions` — исключения форм после слияния (не содержание, лежат вне `StoredWorldEntity`).
 */
export function checkWorldTypeFields(
  entity: StoredWorldEntity,
  exclusions: { aliasExclusions: unknown; aliasChapterExclusions: unknown },
): WorldRefError[] {
  const errors: WorldRefError[] = [];
  const article = /^[aeiou]/.test(entity.type) ? 'an' : 'a';
  const notFor = (path: string) =>
    errors.push({ path, message: `${path} is not a field of ${article} ${entity.type}` });
  const own: ReadonlySet<string> | undefined =
    WORLD_BLOCKS_OF_TYPE[entity.type as BookWorldImportType];
  for (const key of BOOK_WORLD_BLOCK_KEYS) {
    // Отпечаток ТЗ идёт за `imageBrief` и в теле не задаётся: ошибка — только на самом ТЗ.
    if (key === 'imageBriefFor') continue;
    if (hasValue(entity[key]) && !own?.has(key)) notFor(key);
  }
  if (entity.type === 'pair') {
    if (hasValue(entity.role)) notFor('role');
    if (hasValue(entity.aliases)) notFor('aliases');
    if (hasValue(entity.sources)) notFor('sources');
    if (hasValue(exclusions.aliasExclusions)) notFor('aliasExclusions');
    if (hasValue(exclusions.aliasChapterExclusions)) notFor('aliasChapterExclusions');
    return errors;
  }
  if (entity.type === 'place' || isWorldObjectType(entity.type)) {
    if (hasValue(entity.role)) notFor('role');
    if (hasValue(entity.sources)) notFor('sources');
  }
  if (entity.type === 'place') {
    if (hasValue(entity.wikidataId) && !wikidataIdAllowed(entity.kind)) {
      errors.push({
        path: 'wikidataId',
        message: 'wikidataId is only for a real place (kind: real)',
      });
    }
  }
  (entity.quotes ?? []).forEach((q, j) => {
    if (typeof q.aboutKey === 'string' && q.aboutKey !== '') notFor(`quotes.${j}.aboutKey`);
  });
  return errors;
}

/**
 * Сохранённые сущности, которые ссылаются на героя `key` (`relations[].to`, `quotes[].speakerKey`,
 * `quotes[].aboutKey`, `characterKeys[]`; без героев ключа пары — их держит `pairsHolding`). Ключ,
 * который есть и у героя анализа, ссылкой отношения и реплики держится (`checkWorldRefs` принимает
 * ключи анализа), а связью предмета и события — нет: она ведёт только на героя мира (`F08-13a`).
 * Одно правило на отказ удаления (`WORLD_ENTITY_REFERENCED`) и на отказ смены типа героя.
 */
export function entitiesReferring(
  key: string,
  others: readonly { key: string; blocks: unknown }[],
  analysisKeys: ReadonlySet<string>,
): string[] {
  const heldByAnalysis = analysisKeys.has(key);
  return others
    .filter(
      (o) =>
        o.key !== key &&
        worldEntityRefs(readStoredBlocks(o.blocks)).some(
          (r) => r.key === key && (r.kind === 'character' || !heldByAnalysis),
        ),
    )
    .map((o) => o.key);
}

/**
 * Пары версии, в ключ которых входит герой `key` — по ссылкам `member` (`worldEntityRefs`), одно
 * правило с отказом удаления героя (409): смена типа героя пары — 400.
 */
export function pairsHolding(
  key: string,
  entities: readonly Pick<StoredWorldEntity, 'key' | 'type'>[],
): string[] {
  return entities
    .filter((e) =>
      worldEntityRefs({ ...e, relations: null, quotes: null }).some(
        (r) => r.kind === 'member' && r.key === key,
      ),
    )
    .map((e) => e.key);
}

/** Совместное присутствие героев пары — вход условия заведения (`pairFounded`). */
export interface WorldPairEvidence {
  /** Связь героев в `relations` анализа версии — в любую сторону. */
  isLinked: boolean;
  /** Главы присутствия каждого героя; `null` — присутствие ещё не посчитано. */
  chaptersA: number | null;
  chaptersB: number | null;
  /** Общие главы героев (`coPresenceWith` первого со вторым). */
  common: number;
}

/**
 * Вход условия заведения пары (решение арбитра `F08 | F08-8c` Q4): связь героев в `relations`
 * анализа в любую сторону — по ключам: засчитывается, когда ключи героев мира равны ключам героев
 * анализа (их же берёт промпт героя; решение `F08 | F08-1` R7 этого не требует); главы и общие главы — по сохранённому присутствию героев
 * (`mentions.chapters`, `coPresenceWith` — то же правило общих глав, что у присутствия пары);
 * героя без посчитанного присутствия — `null`. Им же отберёт кандидатов пар ход мира (`F08-8e`, Q5).
 */
export function pairEvidenceOf(
  analysisCharacters: unknown,
  mentionsOf: ReadonlyMap<string, unknown>,
): (a: string, b: string) => WorldPairEvidence {
  const related = new Set<string>();
  for (const c of Array.isArray(analysisCharacters) ? analysisCharacters : []) {
    if (!isRecord(c) || typeof c.key !== 'string' || !Array.isArray(c.relations)) continue;
    for (const r of c.relations) {
      if (isRecord(r) && typeof r.to === 'string') related.add(`${c.key}\u0000${r.to}`);
    }
  }
  const counted = (key: string) => {
    const m = mentionsOf.get(key);
    return isRecord(m) && Array.isArray(m.chapters) ? mentionChapters(m).length : null;
  };
  return (a, b) => ({
    isLinked: related.has(`${a}\u0000${b}`) || related.has(`${b}\u0000${a}`),
    chaptersA: counted(a),
    chaptersB: counted(b),
    common: coPresenceWith(mentionsOf.get(a), b).length,
  });
}

/**
 * Условие заведения пары (`product.md` §6, решение арбитра `F08 | F08-8c` Q4): связь в анализе
 * или вместе не меньше чем в трети глав каждого — `3·общие ≥ глав a` и `≥ глав b`, общих хотя бы
 * одна. Присутствие не посчитано и связи нет — нет. Проверяется только при записи пары.
 */
export function pairFounded(e: WorldPairEvidence): boolean {
  if (e.isLinked) return true;
  if (e.chaptersA === null || e.chaptersB === null || e.common < 1) return false;
  return 3 * e.common >= e.chaptersA && 3 * e.common >= e.chaptersB;
}

/**
 * Ключ и состав пары (решения арбитра `F08 | F08-8c` Q1, Q2, Q4, `F08 | F08-8c-1` R1): ключ —
 * `{a}--{b}` с ровно одним `--`, `a` и `b` — разные герои версии по алфавиту — по коду символа
 * (`a < b` строк JS, без локали), ключ не длиннее предела ключа; `quotes[].speakerKey`
 * и `aboutKey` обязательны, оба — только
 * герои пары, и не один и тот же; условие заведения — `pairFounded` по `evidence` (нет — отказ),
 * только у новой пары: `evidence = null` — пара уже заведена, условие не проверяется.
 * Ошибки ключа — путём `key`. Правило порядка и различия героев скопировано на фронт —
 * `books-front/lib/book-world/pair.ts` (`pairKey`, `canonicalPairMembers`); менять вместе.
 */
export function checkWorldPair(
  entity: StoredWorldEntity,
  ctx: WorldRefContext,
  evidence: ((a: string, b: string) => WorldPairEvidence) | null,
): WorldRefError[] {
  const { members, error: formError } = pairKeyCheck(entity.key);
  if (!members) return [{ path: 'key', message: formError ?? '' }];
  const errors: WorldRefError[] = [];
  if (formError !== null) errors.push({ path: 'key', message: formError });
  const [a, b] = members;
  for (const k of missingPairMembers(members, ctx.characterKeys)) {
    errors.push({ path: 'key', message: `"${k}" is not a character of this version` });
  }
  (entity.quotes ?? []).forEach((q, j) => {
    // Цитаты пары — «друг о друге» (`product.md` §6): кто говорит и о ком — обязательно.
    if (typeof q.speakerKey !== 'string' || q.speakerKey === '') {
      errors.push({
        path: `quotes.${j}.speakerKey`,
        message: 'a quote of a pair is said by one of its characters',
      });
    }
    if (typeof q.aboutKey !== 'string' || q.aboutKey === '') {
      errors.push({
        path: `quotes.${j}.aboutKey`,
        message: 'a quote of a pair names the character it is about',
      });
    }
    for (const field of ['speakerKey', 'aboutKey'] as const) {
      const k = q[field];
      if (typeof k === 'string' && k !== '' && !members.includes(k)) {
        errors.push({
          path: `quotes.${j}.${field}`,
          message: `"${k}" is not a character of this pair`,
        });
      }
    }
    if (q.speakerKey && q.aboutKey && q.speakerKey === q.aboutKey) {
      errors.push({
        path: `quotes.${j}.aboutKey`,
        message: 'a quote of a pair is about the other character',
      });
    }
  });
  if (errors.length === 0 && evidence && !pairFounded(evidence(a, b))) {
    errors.push({
      path: 'key',
      message:
        'the characters are not related in the analysis and are not together in a third of the ' +
        'chapters of each (or their mentions are not counted yet)',
    });
  }
  return errors;
}

/** Дубль ключа в теле импорта версии: путь второго и следующих (`entities.N.key`). */
export function duplicateWorldKeys(entities: readonly { key: string }[]): WorldRefError[] {
  const seen = new Set<string>();
  const errors: WorldRefError[] = [];
  entities.forEach((e, i) => {
    if (seen.has(e.key)) {
      errors.push({ path: `entities.${i}.key`, message: `duplicate key "${e.key}"` });
    }
    seen.add(e.key);
  });
  return errors;
}
