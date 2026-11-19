import { isFilled } from '../book-analysis/book-analysis-core';
import { isRecord } from '../../shared/prisma/json-record.util';
import {
  WORLD_CHARACTER_BLOCK_KEYS,
  WORLD_PAIR_BLOCK_KEYS,
  coPresenceWith,
  type StoredWorldEntity,
} from './book-world-data';
import { BOOK_WORLD_KEY_REGEX } from './dto/book-world-blocks.dto';
import { mentionChapters } from './world-core';

const WORLD_PAIR_SEPARATOR = '--';

/**
 * Ключ пары `{a}--{b}` → ключи героев (`F08-8c`, решение арбитра Q1): ровно одно `--`, обе половины
 * не пусты; иначе `null`. Единственный разбор ключа пары; проверки ключа — `checkWorldPair`.
 */
export function pairMembers(key: string): [string, string] | null {
  const at = key.indexOf(WORLD_PAIR_SEPARATOR);
  if (at <= 0 || at !== key.lastIndexOf(WORLD_PAIR_SEPARATOR)) return null;
  const a = key.slice(0, at);
  const b = key.slice(at + WORLD_PAIR_SEPARATOR.length);
  return b === '' ? null : [a, b];
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
 * Ссылки на **слитой** сущности (как `checkAnalysisRefs`): `relations[].to` и `quotes[].speakerKey` —
 * ключ сущности версии или героя анализа (ключ мира не обязан совпадать с анализом, решение
 * арбитра `F08 | F08-1` R7); связь с собой — отказ. Внешние блоки (`critique`, `prototypes`,
 * `adaptations`) — только при `sources` (`tech.md` §3).
 */
export function checkWorldRefs(entity: StoredWorldEntity, ctx: WorldRefContext): WorldRefError[] {
  const errors: WorldRefError[] = [];
  // Ссылки героя — на героя мира или анализа (`tech.md` §3), не на пару (`F08-8c`): ключ пары —
  // тоже ключ сущности версии, но страница сравнения не адресат отношения или реплики.
  const known = (key: string) => ctx.characterKeys.has(key) || ctx.analysisKeys.has(key);

  for (const ref of worldEntityRefs(entity)) {
    // Ссылки пары проверяет `checkWorldPair` (только герои пары); `relations` у пары нет вовсе
    // (`checkWorldTypeFields`) — одна ошибка на поле, а не две.
    if (entity.type === 'pair') continue;
    if (ref.kind === 'relation' && ref.key === entity.key) {
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

type WorldRefKind = 'relation' | 'speaker' | 'about' | 'member';

/**
 * Поля-ссылки сущности на ключи — один перечень на проверку ссылок и на отказ удаления
 * (`WORLD_ENTITY_REFERENCED`): `relations[].to`, `quotes[].speakerKey`, `quotes[].aboutKey` и
 * герои ключа пары (`member`, `F08-8c`: героя из-под пары не удалить).
 */
export function worldEntityRefs(
  entity: Pick<StoredWorldEntity, 'relations' | 'quotes'> &
    Partial<Pick<StoredWorldEntity, 'key' | 'type'>>,
): { kind: WorldRefKind; path: string; key: string }[] {
  const refs: { kind: WorldRefKind; path: string; key: string }[] = [];
  const members = entity.type === 'pair' && entity.key ? pairMembers(entity.key) : null;
  for (const key of members ?? []) refs.push({ kind: 'member', path: 'key', key });
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
 * Поля не своего типа (`F08-8c`): у пары нет роли, форм имени (решение арбитра Q6: её имя не
 * ищется в тексте), источников (внешних блоков у пары нет, `product.md` §6, Q2) и полей страницы
 * героя; у героя — полей пары и `quotes[].aboutKey`. Перечни полей — `book-world-data.ts`.
 * `exclusions` — исключения форм после слияния (не содержание, лежат вне `StoredWorldEntity`).
 */
export function checkWorldTypeFields(
  entity: StoredWorldEntity,
  exclusions: { aliasExclusions: unknown; aliasChapterExclusions: unknown },
): WorldRefError[] {
  const errors: WorldRefError[] = [];
  const notFor = (path: string) =>
    errors.push({ path, message: `${path} is not a field of a ${entity.type}` });
  if (entity.type === 'pair') {
    for (const key of WORLD_CHARACTER_BLOCK_KEYS) if (hasValue(entity[key])) notFor(key);
    if (hasValue(entity.role)) notFor('role');
    if (hasValue(entity.aliases)) notFor('aliases');
    if (hasValue(entity.sources)) notFor('sources');
    if (hasValue(exclusions.aliasExclusions)) notFor('aliasExclusions');
    if (hasValue(exclusions.aliasChapterExclusions)) notFor('aliasChapterExclusions');
  } else {
    for (const key of WORLD_PAIR_BLOCK_KEYS) if (hasValue(entity[key])) notFor(key);
    (entity.quotes ?? []).forEach((q, j) => {
      if (typeof q.aboutKey === 'string' && q.aboutKey !== '') notFor(`quotes.${j}.aboutKey`);
    });
  }
  return errors;
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
 * Ошибки ключа — путём `key`.
 */
export function checkWorldPair(
  entity: StoredWorldEntity,
  ctx: WorldRefContext,
  evidence: ((a: string, b: string) => WorldPairEvidence) | null,
): WorldRefError[] {
  const members = pairMembers(entity.key);
  if (!members || !BOOK_WORLD_KEY_REGEX.test(entity.key)) {
    return [
      { path: 'key', message: 'a pair key is {a}--{b}: two character keys joined by one "--"' },
    ];
  }
  const errors: WorldRefError[] = [];
  const [a, b] = members;
  if (a === b) {
    errors.push({ path: 'key', message: 'a pair needs two different characters' });
  } else if (a > b) {
    errors.push({ path: 'key', message: `pair keys go in alphabetical order: "${b}--${a}"` });
  }
  for (const k of new Set(members)) {
    if (!ctx.characterKeys.has(k)) {
      errors.push({ path: 'key', message: `"${k}" is not a character of this version` });
    }
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
