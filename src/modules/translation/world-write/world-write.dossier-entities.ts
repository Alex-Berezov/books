import type { StoredWorldEntity } from '../../book-world/book-world-data';
import {
  BOOK_WORLD_KEY_REGEX,
  BOOK_WORLD_LIMITS,
} from '../../book-world/dto/book-world-blocks.dto';
import { isRecord } from '../../../shared/prisma/json-record.util';
import type { DossierEntityDto } from '../dto/dossier-data.dto';
import { hasWorldObjectExample, hasWorldPlaceExample } from './examples';
import {
  WORLD_OBJECT_MIN_CHAPTERS,
  WORLD_OBJECTS_MAX,
  WORLD_PLACE_MIN_CHAPTERS,
  WORLD_PLACES_MAX,
  WORLD_TERM_MIN_CHAPTERS,
  WORLD_TERMS_MAX,
} from './world-write.constants';
import type {
  WorldDossierCandidate,
  WorldDossierType,
  WorldObjectsOffReason,
  WorldPlacesOffReason,
  WorldSkip,
  WorldSkipReason,
  WorldTermsOffReason,
} from './world-write.data';

/**
 * Сущности досье хода «Write World» - места (`F08-12b`), предметы и понятия (`F08-13b`): одна реализация
 * отбора с правилами типа (`RULES`, решение арбитра `F08 | F08-13b` R1). Кандидат - сущность досье
 * своего вида с ключом досье как есть; ключ, занятый сущностью или кандидатом другого типа, - отсеян
 * с `*_KEY_TAKEN`; после подсчёта присутствия - порог глав и потолок своего типа. Новый тип шага досье
 * добавляет строку в `RULES`, а не копию функций (`folder-structure.md`, world-write).
 */

export type { WorldDossierType, WorldRunObjectType } from './world-write.data';

/** Сущность досье до подсчёта присутствия: ключ и название досье. */
export interface WorldDossierEntry {
  key: string;
  name: string;
}

/** Причина хода без сущностей типа (язык без эталона) - своё поле данных хода на тип. */
interface WorldDossierOffReasons {
  place: WorldPlacesOffReason;
  object: WorldObjectsOffReason;
  term: WorldTermsOffReason;
}

/** Правила типа: порог и потолок, причины отсева, эталон языка, причина выключения. */
interface WorldDossierRules<Off> {
  min: number;
  max: number;
  below: WorldSkipReason;
  taken: WorldSkipReason;
  over: WorldSkipReason;
  hasExample: (language: string) => boolean;
  off: Off;
}

const RULES: { [K in WorldDossierType]: WorldDossierRules<WorldDossierOffReasons[K]> } = {
  // Ядро места - две сцены: порог 2 главы (`F08 | F08-12b` Q1).
  place: {
    min: WORLD_PLACE_MIN_CHAPTERS,
    max: WORLD_PLACES_MAX,
    below: 'PLACE_BELOW_MIN_CHAPTERS',
    taken: 'PLACE_KEY_TAKEN',
    over: 'PLACES_MAX',
    hasExample: hasWorldPlaceExample,
    off: 'WORLD_PLACE_LANGUAGE',
  },
  // Ядро предмета и понятия без сцен: порог 1 глава (`F08 | F08-13b` Q1).
  object: {
    min: WORLD_OBJECT_MIN_CHAPTERS,
    max: WORLD_OBJECTS_MAX,
    below: 'OBJECT_BELOW_MIN_CHAPTERS',
    taken: 'OBJECT_KEY_TAKEN',
    over: 'OBJECTS_MAX',
    hasExample: (language) => hasWorldObjectExample(language, 'object'),
    off: 'WORLD_OBJECT_LANGUAGE',
  },
  term: {
    min: WORLD_TERM_MIN_CHAPTERS,
    max: WORLD_TERMS_MAX,
    below: 'TERM_BELOW_MIN_CHAPTERS',
    taken: 'TERM_KEY_TAKEN',
    over: 'TERMS_MAX',
    hasExample: (language) => hasWorldObjectExample(language, 'term'),
    off: 'WORLD_TERM_LANGUAGE',
  },
};

/**
 * Сущности досье одного вида - одно правило на места, предметы, понятия и организации: вид с обрезкой
 * пробелов, ключ по правилу ключа мира, название в пределе импорта; ключ - один раз на вид (досье
 * с повтором ключа берёт первую сущность). Досье не той формы - сущностей нет.
 */
export function dossierEntitiesOf(
  dossier: unknown,
  kind: DossierEntityDto['kind'],
): WorldDossierEntry[] {
  const entities = isRecord(dossier) && Array.isArray(dossier.entities) ? dossier.entities : [];
  const out: WorldDossierEntry[] = [];
  for (const e of entities) {
    // Вид - с обрезкой пробелов, как у форм названия (`dossierEntityForms`): одно правило на досье.
    if (!isRecord(e) || (typeof e.kind === 'string' ? e.kind.trim() : '') !== kind) continue;
    const key = typeof e.key === 'string' ? e.key.trim() : '';
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!BOOK_WORLD_KEY_REGEX.test(key) || name === '' || name.length > BOOK_WORLD_LIMITS.name) {
      continue;
    }
    if (out.some((p) => p.key === key)) continue;
    out.push({ key, name });
  }
  return out;
}

/**
 * Ключ сущности типа занят сохранённой сущностью другого типа: одно правило на выбор
 * (`runDossierEntities`) и на шаг (`*_KEY_TAKEN` без платного вызова), как `pairKeyTaken` у пар.
 */
export const dossierKeyTaken = (type: WorldDossierType, storedType: string | undefined): boolean =>
  storedType !== undefined && storedType !== type;

/**
 * Выбирает ли шаг выбора сущности типа (одно условие на промпт выбора и `chooseDossierEntities`):
 * `old` - ход, начатый до этого типа (`previous` не `null`: поля нет - `[]`), их не получает -
 * его оценка их не включала; `language` - язык без эталона типа; `on` - выбираются.
 */
export function dossierTypeMode(
  language: string,
  type: WorldDossierType,
  previous: WorldDossierCandidate[] | null,
): 'old' | 'language' | 'on' {
  if (previous !== null) return 'old';
  return RULES[type].hasExample(language) ? 'on' : 'language';
}

/** Сущности досье типа, которые ход может взять (`free`), и на занятом ключе (`taken`). */
export interface WorldDossierChosen {
  free: WorldDossierEntry[];
  taken: WorldDossierEntry[];
}

/**
 * Сущности досье типа и на занятом ключе: ключ сохранённой сущности другого типа или из `otherKeys`
 * (герой анализа, сущность досье старшего типа). Иначе запись поверх чужого типа отбилась бы 400 уже
 * после платного шага (`checkWorldTypeFields`).
 */
export function runDossierEntities(
  dossier: unknown,
  type: WorldDossierType,
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
  otherKeys: ReadonlySet<string>,
): WorldDossierChosen {
  const out: WorldDossierChosen = { free: [], taken: [] };
  for (const entry of dossierEntitiesOf(dossier, type)) {
    const busy = otherKeys.has(entry.key) || dossierKeyTaken(type, entities.get(entry.key)?.type);
    (busy ? out.taken : out.free).push(entry);
  }
  return out;
}

/**
 * Сущности после выбора пар: на ключе пары этого хода - на занятом ключе (запись пары и сущности
 * спорили бы за адрес), остальные идут в подсчёт присутствия.
 */
export function entriesAfterPairs(
  chosen: WorldDossierChosen,
  pairKeys: ReadonlySet<string>,
): WorldDossierChosen {
  return {
    free: chosen.free.filter((p) => !pairKeys.has(p.key)),
    taken: [...chosen.taken, ...chosen.free.filter((p) => pairKeys.has(p.key))],
  };
}

const byKey = (x: { key: string }, y: { key: string }): number =>
  x.key < y.key ? -1 : x.key > y.key ? 1 : 0;

/**
 * Сущности типа после подсчёта присутствия: ниже порога глав - `*_BELOW_MIN_CHAPTERS`; остальные по
 * убыванию глав, при равенстве - по ключу; сверх потолка - `*_MAX`.
 */
export function selectDossierEntities(
  type: WorldDossierType,
  counted: readonly WorldDossierCandidate[],
): { list: WorldDossierCandidate[]; skipped: WorldSkip[] } {
  const rules = RULES[type];
  const skip = (o: WorldDossierCandidate, reason: WorldSkipReason): WorldSkip => ({
    key: o.key,
    reason,
    names: [o.name],
    chapters: o.mentions.chapters.length,
  });
  const passing = counted
    .filter((o) => o.mentions.chapters.length >= rules.min)
    .sort((x, y) => y.mentions.chapters.length - x.mentions.chapters.length || byKey(x, y));
  return {
    list: passing.slice(0, rules.max),
    skipped: [
      ...counted
        .filter((o) => o.mentions.chapters.length < rules.min)
        .map((o) => skip(o, rules.below)),
      ...passing.slice(rules.max).map((o) => skip(o, rules.over)),
    ],
  };
}

/**
 * Сущности типа хода и отсеянные шагом выбора - весь отбор типа в одном месте: на занятом ключе -
 * `*_KEY_TAKEN`, затем порог и потолок (`selectDossierEntities`). Ход до типа (`dossierTypeMode` `old`)
 * - прежний список без отсева; язык без эталона типа - пусто и причина выключения (`off`).
 */
export function chooseDossierEntities<K extends WorldDossierType>(
  type: K,
  language: string,
  counted: readonly WorldDossierCandidate[],
  taken: readonly WorldDossierEntry[],
  previous: WorldDossierCandidate[] | null,
): { list: WorldDossierCandidate[]; leftOut: WorldSkip[]; off: WorldDossierOffReasons[K] | null } {
  const mode = dossierTypeMode(language, type, previous);
  if (mode === 'old') return { list: previous ?? [], leftOut: [], off: null };
  const rules: WorldDossierRules<WorldDossierOffReasons[K]> = RULES[type];
  if (mode === 'language') return { list: [], leftOut: [], off: rules.off };
  const selection = selectDossierEntities(type, counted);
  return {
    list: selection.list,
    leftOut: [
      ...taken.map(
        (o): WorldSkip => ({ key: o.key, reason: rules.taken, names: [o.name], chapters: null }),
      ),
      ...selection.skipped,
    ],
    off: null,
  };
}

/**
 * Шагов типа сверху - оценка до старта (присутствие неизвестно; `F08-12b`, `F08 | F08-13b` Q9):
 * сущности типа досье, не больше потолка; досье ещё нет - потолок; язык без эталона типа - 0.
 */
export function dossierStepsUpperBound(
  dossier: unknown,
  language: string,
  type: WorldDossierType,
): number {
  const rules = RULES[type];
  if (!rules.hasExample(language)) return 0;
  if (dossier === null || dossier === undefined) return rules.max;
  return Math.min(rules.max, dossierEntitiesOf(dossier, type).length);
}
