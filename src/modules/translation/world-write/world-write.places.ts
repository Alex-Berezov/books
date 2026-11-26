import type { StoredWorldEntity } from '../../book-world/book-world-data';
import {
  BOOK_WORLD_KEY_REGEX,
  BOOK_WORLD_LIMITS,
} from '../../book-world/dto/book-world-blocks.dto';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { hasWorldPlaceExample } from './examples';
import { WORLD_PLACE_MIN_CHAPTERS, WORLD_PLACES_MAX } from './world-write.constants';
import type { WorldPlaceCandidate, WorldPlacesOffReason, WorldSkip } from './world-write.data';

/**
 * Места хода «Write World» (`F08-12b`, решение арбитра `F08 | F08-12b` Q1): кандидаты - места досье
 * (`entities[]` с `kind: 'place'`) с ключом досье как есть (досье одно на исходник - ключ общий для его
 * переводов); ключ, занятый сущностью или кандидатом другого типа, - отсеян с `PLACE_KEY_TAKEN`; после
 * подсчёта присутствия - порог `WORLD_PLACE_MIN_CHAPTERS` глав и потолок `WORLD_PLACES_MAX`.
 */

/** Место досье до подсчёта присутствия: ключ и название досье. */
export interface WorldBasePlace {
  key: string;
  name: string;
}

/**
 * Места досье версии: `kind: 'place'`, ключ по правилу ключа мира, название в пределе импорта; ключ -
 * один раз (досье с повтором ключа берёт первое место). Досье не той формы - мест нет.
 */
export function dossierPlaces(dossier: unknown): WorldBasePlace[] {
  const entities = isRecord(dossier) && Array.isArray(dossier.entities) ? dossier.entities : [];
  const out: WorldBasePlace[] = [];
  for (const e of entities) {
    // Вид - с обрезкой пробелов, как у форм названия (`placeDossierForms`): одно правило на досье.
    if (!isRecord(e) || (typeof e.kind === 'string' ? e.kind.trim() : '') !== 'place') continue;
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
 * Ключ места занят сохранённой сущностью другого типа (`F08-12b`, Q1): одно правило на выбор
 * (`runPlaces`) и на шаг места (`WORLD_PLACE_KEY_TAKEN` без платного вызова), как `pairKeyTaken` у пар.
 */
export const placeKeyTaken = (storedType: string | undefined): boolean =>
  storedType !== undefined && storedType !== 'place';

/**
 * Места досье, которые ход может взять (`places`), и места на занятом ключе (`taken`): ключ сохранённой
 * сущности не-места, героя анализа версии или пары хода (`otherKeys`). Иначе запись места поверх героя
 * или героя поверх места отбилась бы 400 уже после платного шага (`checkWorldTypeFields`).
 */
export function runPlaces(
  dossier: unknown,
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
  otherKeys: ReadonlySet<string>,
): { places: WorldBasePlace[]; taken: WorldBasePlace[] } {
  const places: WorldBasePlace[] = [];
  const taken: WorldBasePlace[] = [];
  for (const place of dossierPlaces(dossier)) {
    const busy = otherKeys.has(place.key) || placeKeyTaken(entities.get(place.key)?.type);
    (busy ? taken : places).push(place);
  }
  return { places, taken };
}

const byKey = (x: { key: string }, y: { key: string }): number =>
  x.key < y.key ? -1 : x.key > y.key ? 1 : 0;

/**
 * Места хода после подсчёта присутствия (Q1): ниже `WORLD_PLACE_MIN_CHAPTERS` глав -
 * `PLACE_BELOW_MIN_CHAPTERS`; остальные по убыванию глав, при равенстве - по ключу; сверх
 * `WORLD_PLACES_MAX` - `PLACES_MAX`.
 */
export function selectWorldPlaces(counted: readonly WorldPlaceCandidate[]): {
  places: WorldPlaceCandidate[];
  skipped: WorldSkip[];
} {
  const skip = (p: WorldPlaceCandidate, reason: WorldSkip['reason']): WorldSkip => ({
    key: p.key,
    reason,
    names: [p.name],
    chapters: p.mentions.chapters.length,
  });
  const passing = counted
    .filter((p) => p.mentions.chapters.length >= WORLD_PLACE_MIN_CHAPTERS)
    .sort((x, y) => y.mentions.chapters.length - x.mentions.chapters.length || byKey(x, y));
  return {
    places: passing.slice(0, WORLD_PLACES_MAX),
    skipped: [
      ...counted
        .filter((p) => p.mentions.chapters.length < WORLD_PLACE_MIN_CHAPTERS)
        .map((p) => skip(p, 'PLACE_BELOW_MIN_CHAPTERS')),
      ...passing.slice(WORLD_PLACES_MAX).map((p) => skip(p, 'PLACES_MAX')),
    ],
  };
}

/**
 * Выбирает ли шаг выбора места (одно условие на промпт выбора и `choosePlaces`, R4 `F08 | F08-12b`):
 * `old` - ход, начатый до `F08-12b` (`previous` не `null`), мест не получает; `language` - язык без
 * эталона места; `on` - места выбираются.
 */
export function placesMode(
  language: string,
  previous: WorldPlaceCandidate[] | null,
): 'old' | 'language' | 'on' {
  if (previous !== null) return 'old';
  return hasWorldPlaceExample(language) ? 'on' : 'language';
}

/**
 * Места досье шага выбора (вход промпта): при `placesMode` `on` - `runPlaces` по ключам героев анализа
 * и сохранённым сущностям, иначе мест нет.
 */
export function placesToChoose(
  language: string,
  previous: WorldPlaceCandidate[] | null,
  dossier: unknown,
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
  analysisKeys: ReadonlySet<string>,
): { places: WorldBasePlace[]; taken: WorldBasePlace[] } {
  return placesMode(language, previous) === 'on'
    ? runPlaces(dossier, entities, analysisKeys)
    : { places: [], taken: [] };
}

/**
 * Места после выбора пар: место на ключе пары этого хода - на занятом ключе (запись пары и места
 * спорили бы за адрес), остальные идут в подсчёт присутствия.
 */
export function placesAfterPairs(
  chosen: { places: readonly WorldBasePlace[]; taken: readonly WorldBasePlace[] },
  pairKeys: ReadonlySet<string>,
): { free: WorldBasePlace[]; taken: WorldBasePlace[] } {
  return {
    free: chosen.places.filter((p) => !pairKeys.has(p.key)),
    taken: [...chosen.taken, ...chosen.places.filter((p) => pairKeys.has(p.key))],
  };
}

/**
 * Места хода и отсеянные шагом выбора (`F08-12b`) - весь отбор мест в одном месте. `previous` - места,
 * прочитанные из данных хода до выбора: не `null` только у хода, начатого до `F08-12b` (поля нет - `[]`);
 * его оценка мест не включала, места ему не выбираются (как пары, Q2 `F08 | F08-8e-4`). На языке без
 * эталона места мест нет (`WORLD_PLACE_LANGUAGE`).
 */
export function choosePlaces(
  language: string,
  counted: readonly WorldPlaceCandidate[],
  taken: readonly WorldBasePlace[],
  previous: WorldPlaceCandidate[] | null,
): { places: WorldPlaceCandidate[]; leftOut: WorldSkip[]; placesOff: WorldPlacesOffReason | null } {
  const mode = placesMode(language, previous);
  if (mode === 'old') return { places: previous ?? [], leftOut: [], placesOff: null };
  if (mode === 'language') return { places: [], leftOut: [], placesOff: 'WORLD_PLACE_LANGUAGE' };
  const selection = selectWorldPlaces(counted);
  return {
    places: selection.places,
    leftOut: [
      ...taken.map(
        (p): WorldSkip => ({
          key: p.key,
          reason: 'PLACE_KEY_TAKEN',
          names: [p.name],
          chapters: null,
        }),
      ),
      ...selection.skipped,
    ],
    placesOff: null,
  };
}

/**
 * Шагов мест сверху - оценка до старта (присутствие неизвестно): места досье, не больше
 * `WORLD_PLACES_MAX`; досье ещё нет - потолок; язык без эталона места - 0.
 */
export function placeStepsUpperBound(dossier: unknown, language: string): number {
  if (!hasWorldPlaceExample(language)) return 0;
  if (dossier === null || dossier === undefined) return WORLD_PLACES_MAX;
  return Math.min(WORLD_PLACES_MAX, dossierPlaces(dossier).length);
}
