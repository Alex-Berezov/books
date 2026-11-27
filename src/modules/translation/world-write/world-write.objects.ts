import type { StoredWorldEntity } from '../../book-world/book-world-data';
import type { WorldObjectCandidate, WorldSkip } from './world-write.data';
import {
  dossierEntitiesOf,
  dossierTypeMode,
  runDossierEntities,
  type WorldDossierChosen,
  type WorldDossierEntry,
} from './world-write.dossier-entities';

/**
 * Предметы и понятия хода «Write World» (`F08-13b`, решения арбитра `F08 | F08-13b` Q1, R3 и
 * `F08 | F08-13` Q5): кандидаты - сущности досье `kind: 'object'` и `kind: 'term'` с ключом досье как
 * есть; организация досье понятием не становится - в `leftOut` с `ORGANIZATION_SKIPPED`. Ключ сверяется
 * до платного шага с ключами всех типов: сохранённая сущность другого типа, герой анализа, пара хода,
 * место досье, предмет досье (для понятия). Порог, потолок и отсев - общие у сущностей досье
 * (`world-write.dossier-entities.ts`, R1); здесь - только старшинство ключей и организации.
 */

/** Вход шага выбора: предметы, понятия и организации досье. */
export interface WorldObjectsToChoose {
  objects: WorldDossierChosen;
  terms: WorldDossierChosen;
  /** Организации досье - в `leftOut` (`ORGANIZATION_SKIPPED`); у старого хода - пусто. */
  organizations: WorldDossierEntry[];
}

const NONE: WorldDossierChosen = { free: [], taken: [] };

/**
 * Предметы, понятия и организации досье шага выбора (`F08-13b`, Q1, R3): ключ, занятый героем анализа
 * (`analysisKeys`), местом досье, сохранённой сущностью другого типа, а у понятия ещё и предметом
 * досье, - на занятом ключе (иначе запись отбилась бы 400 после платного шага, `checkWorldTypeFields`).
 * Пары хода выбираются позже - их ключи снимает `entriesAfterPairs`. `previous` - списки, прочитанные
 * из данных хода до выбора (не `null` - ход до `F08-13b`).
 */
export function objectsToChoose(
  language: string,
  previous: { objects: WorldObjectCandidate[] | null; terms: WorldObjectCandidate[] | null },
  dossier: unknown,
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
  analysisKeys: ReadonlySet<string>,
): WorldObjectsToChoose {
  const placeKeys = dossierEntitiesOf(dossier, 'place').map((p) => p.key);
  const objectKeys = dossierEntitiesOf(dossier, 'object').map((o) => o.key);
  const forObjects = new Set([...analysisKeys, ...placeKeys]);
  const forTerms = new Set([...forObjects, ...objectKeys]);
  const fresh = previous.objects === null || previous.terms === null;
  return {
    objects:
      dossierTypeMode(language, 'object', previous.objects) === 'on'
        ? runDossierEntities(dossier, 'object', entities, forObjects)
        : NONE,
    terms:
      dossierTypeMode(language, 'term', previous.terms) === 'on'
        ? runDossierEntities(dossier, 'term', entities, forTerms)
        : NONE,
    organizations: fresh ? dossierEntitiesOf(dossier, 'organization') : [],
  };
}

/** Организации досье в `leftOut` (`F08 | F08-13` Q5): ход их не пишет - ни понятием, ни своим типом. */
export const organizationsSkipped = (organizations: readonly WorldDossierEntry[]): WorldSkip[] =>
  organizations.map((o) => ({
    key: o.key,
    reason: 'ORGANIZATION_SKIPPED',
    names: [o.name],
    chapters: null,
  }));
