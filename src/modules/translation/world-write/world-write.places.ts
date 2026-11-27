import type { StoredWorldEntity } from '../../book-world/book-world-data';
import type { WorldPlaceCandidate, WorldPlacesOffReason, WorldSkip } from './world-write.data';
import {
  chooseDossierEntities,
  dossierEntitiesOf,
  dossierStepsUpperBound,
  dossierTypeMode,
  entriesAfterPairs,
  runDossierEntities,
  selectDossierEntities,
  type WorldDossierEntry,
} from './world-write.dossier-entities';

/**
 * Места хода «Write World» (`F08-12b`, решение арбитра `F08 | F08-12b` Q1): кандидаты - места досье
 * (`entities[]` с `kind: 'place'`) с ключом досье как есть (досье одно на исходник - ключ общий для его
 * переводов); ключ, занятый сущностью или кандидатом другого типа, - отсеян с `PLACE_KEY_TAKEN`; после
 * подсчёта присутствия - порог `WORLD_PLACE_MIN_CHAPTERS` глав и потолок `WORLD_PLACES_MAX`. Отбор -
 * общий у сущностей досье (`world-write.dossier-entities.ts`, `F08 | F08-13b` R1): здесь - его форма
 * для мест.
 */

/**
 * Места досье версии: `kind: 'place'`, ключ по правилу ключа мира, название в пределе импорта; ключ -
 * один раз (досье с повтором ключа берёт первое место). Досье не той формы - мест нет.
 */
export function dossierPlaces(dossier: unknown): WorldDossierEntry[] {
  return dossierEntitiesOf(dossier, 'place');
}

/**
 * Места досье, которые ход может взять (`places`), и места на занятом ключе (`taken`): ключ сохранённой
 * сущности не-места, героя анализа версии или пары хода (`otherKeys`). Иначе запись места поверх героя
 * или героя поверх места отбилась бы 400 уже после платного шага (`checkWorldTypeFields`).
 */
export function runPlaces(
  dossier: unknown,
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
  otherKeys: ReadonlySet<string>,
): { places: WorldDossierEntry[]; taken: WorldDossierEntry[] } {
  const chosen = runDossierEntities(dossier, 'place', entities, otherKeys);
  return { places: chosen.free, taken: chosen.taken };
}

/**
 * Места хода после подсчёта присутствия (Q1): ниже `WORLD_PLACE_MIN_CHAPTERS` глав -
 * `PLACE_BELOW_MIN_CHAPTERS`; остальные по убыванию глав, при равенстве - по ключу; сверх
 * `WORLD_PLACES_MAX` - `PLACES_MAX`.
 */
export function selectWorldPlaces(counted: readonly WorldPlaceCandidate[]): {
  places: WorldPlaceCandidate[];
  skipped: WorldSkip[];
} {
  const selection = selectDossierEntities('place', counted);
  return { places: selection.list, skipped: selection.skipped };
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
  return dossierTypeMode(language, 'place', previous);
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
): { places: WorldDossierEntry[]; taken: WorldDossierEntry[] } {
  return placesMode(language, previous) === 'on'
    ? runPlaces(dossier, entities, analysisKeys)
    : { places: [], taken: [] };
}

/**
 * Места после выбора пар: место на ключе пары этого хода - на занятом ключе (запись пары и места
 * спорили бы за адрес), остальные идут в подсчёт присутствия.
 */
export function placesAfterPairs(
  chosen: { places: readonly WorldDossierEntry[]; taken: readonly WorldDossierEntry[] },
  pairKeys: ReadonlySet<string>,
): { free: WorldDossierEntry[]; taken: WorldDossierEntry[] } {
  return entriesAfterPairs({ free: [...chosen.places], taken: [...chosen.taken] }, pairKeys);
}

/**
 * Места хода и отсеянные шагом выбора (`F08-12b`). `previous` - места, прочитанные из данных хода до
 * выбора: не `null` только у хода, начатого до `F08-12b` (поля нет - `[]`); его оценка мест не включала,
 * места ему не выбираются (как пары, Q2 `F08 | F08-8e-4`). На языке без эталона места мест нет
 * (`WORLD_PLACE_LANGUAGE`).
 */
export function choosePlaces(
  language: string,
  counted: readonly WorldPlaceCandidate[],
  taken: readonly WorldDossierEntry[],
  previous: WorldPlaceCandidate[] | null,
): { places: WorldPlaceCandidate[]; leftOut: WorldSkip[]; placesOff: WorldPlacesOffReason | null } {
  const choice = chooseDossierEntities('place', language, counted, taken, previous);
  return { places: choice.list, leftOut: choice.leftOut, placesOff: choice.off };
}

/**
 * Шагов мест сверху - оценка до старта (присутствие неизвестно): места досье, не больше
 * `WORLD_PLACES_MAX`; досье ещё нет - потолок; язык без эталона места - 0.
 */
export function placeStepsUpperBound(dossier: unknown, language: string): number {
  return dossierStepsUpperBound(dossier, language, 'place');
}
