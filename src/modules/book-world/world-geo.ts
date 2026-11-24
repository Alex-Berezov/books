import { isRecord } from '../../shared/prisma/json-record.util';
import { stableJson } from '../../shared/json/stable-json';
import { WIKIDATA_ID_REGEX } from './dto/book-world-blocks.dto';
import { foldMention } from './world-mentions';

/**
 * Координаты места (`F08-12a`, решение арбитра `F08 | F08-12` Q2): только из Wikidata, свойство
 * P625, по номеру сущности `wikidataId` места. Числа из входа и от модели не принимаются вовсе:
 * колонку `geo` пишет только сервер (`WorldGeoService`) после проверки ответа Wikidata этим файлом.
 *
 * Хранение (колонка `geo`, Json): что проверено (`wikidataId`, `checkedFor` — отпечаток входа
 * проверки), когда, итог — точка или причина её отсутствия. Читателю отдаются только точка
 * и ссылка на источник (`publicPoint`), редактору — и причина.
 */

/** Земля в Wikidata: P625 на другом небесном теле (Луна, Марс) — не точка нашей карты. */
export const WIKIDATA_EARTH = 'http://www.wikidata.org/entity/Q2';

/** Постоянный адрес чтения сущности: хост не приходит из входа ни в каком виде. */
export const WIKIDATA_HOST = 'www.wikidata.org';
export const wikidataEntityUrl = (id: string) =>
  `https://${WIKIDATA_HOST}/wiki/Special:EntityData/${id}.json`;
/** Ссылка на страницу сущности — источник точки для читателя и редактора. */
export const wikidataPageUrl = (id: string) => `https://${WIKIDATA_HOST}/wiki/${id}`;

/**
 * Почему точки нет: сущности нет (`not_found`), у неё нет координат P625 (`no_coordinates`),
 * координаты не на Земле (`not_earth`) или вне допустимых границ (`out_of_range`), подпись и
 * синонимы на языке версии не совпали с названием места (`name_mismatch`). `unavailable` в колонку
 * не пишется (отказ Wikidata — не итог проверки, решение `F08 | F08-12a` R1): так редактору
 * называется реальное место, для текущих номера и названий которого проверки нет — Wikidata не
 * ответила или проверка ещё не прошла; следующая запись проверит снова (`geoCheckOf`).
 */
export const WORLD_GEO_REASONS = [
  'not_found',
  'no_coordinates',
  'not_earth',
  'out_of_range',
  'name_mismatch',
  'unavailable',
] as const;
export type WorldGeoReason = (typeof WORLD_GEO_REASONS)[number];

export interface WorldGeoPoint {
  lat: number;
  lng: number;
}

export interface StoredWorldGeo {
  wikidataId: string;
  /** Отпечаток входа проверки (`geoInputOf`): тот же — повторный запрос не нужен. */
  checkedFor: string;
  /**
   * Язык версии на момент проверки — вход отпечатка. Язык версии не меняется, поэтому по нему
   * выдача пересчитывает отпечаток текущих названий (`publicPoint`) без чтения версии.
   */
  language: string;
  checkedAt: string;
  point: WorldGeoPoint | null;
  reason: WorldGeoReason | null;
}

/** Что сверяется с Wikidata: номер, язык версии и названия места. */
export interface WorldGeoInput {
  wikidataId: string;
  language: string;
  names: string[];
}

/**
 * Вход проверки места: только реальное место с номером Wikidata; иначе точки нет и проверять
 * нечего (`null`). Названия — имя и формы имени: та же опора, что у поиска в тексте.
 */
export function geoInputOf(
  entity: {
    type: string;
    kind: string | null;
    wikidataId: string | null;
    name: string | null;
    aliases: readonly string[] | null;
  },
  language: string,
): WorldGeoInput | null {
  if (entity.type !== 'place' || entity.kind !== 'real') return null;
  if (!entity.wikidataId || !WIKIDATA_ID_REGEX.test(entity.wikidataId)) return null;
  const names = [entity.name, ...(entity.aliases ?? [])].filter(
    (n): n is string => typeof n === 'string' && n.trim() !== '',
  );
  return { wikidataId: entity.wikidataId, language, names };
}

/** Отпечаток входа: имена без порядка и повторов — перестановка форм проверку не повторяет. */
export function geoFingerprint(input: WorldGeoInput): string {
  return stableJson({
    wikidataId: input.wikidataId,
    language: input.language,
    names: [...new Set(input.names.map((n) => foldMention(n).trim()))].sort(),
  });
}

/**
 * Проверку надо сделать: вход есть, а сохранённого итога нет или он для другого входа (отказ
 * Wikidata итог не пишет — прежний остаётся, и вход с ним расходится). Нет входа — проверять нечего.
 */
export function geoNeedsCheck(stored: StoredWorldGeo | null, input: WorldGeoInput | null): boolean {
  if (!input) return false;
  if (!stored) return true;
  return stored.checkedFor !== geoFingerprint(input);
}

/** Подписи и синонимы сущности на языке версии (и `mul` — подпись Wikidata «на всех языках»). */
function wikidataNames(entity: Record<string, unknown>, language: string): string[] {
  const out: string[] = [];
  for (const lang of [language, 'mul']) {
    const label = isRecord(entity.labels) ? entity.labels[lang] : undefined;
    if (isRecord(label) && typeof label.value === 'string') out.push(label.value);
    const aliases = isRecord(entity.aliases) ? entity.aliases[lang] : undefined;
    if (Array.isArray(aliases)) {
      for (const a of aliases) if (isRecord(a) && typeof a.value === 'string') out.push(a.value);
    }
  }
  return out;
}

/**
 * Координаты P625: заявление с рангом `preferred`, иначе первое `normal`; `deprecated` не берётся.
 * Значение без чисел — нет координат.
 */
function coordinateOf(
  entity: Record<string, unknown>,
): { latitude: number; longitude: number; globe: unknown } | null {
  const claims = isRecord(entity.claims) ? entity.claims.P625 : undefined;
  if (!Array.isArray(claims)) return null;
  // Заявление без числового значения (`novalue`, `somevalue`) не выбирается: иначе оно заслонило бы
  // следующее заявление с настоящими координатами.
  const usable = (claims as unknown[]).filter(
    (c): c is Record<string, unknown> =>
      isRecord(c) && c.rank !== 'deprecated' && coordinateValue(c) !== null,
  );
  const claim = usable.find((c) => c.rank === 'preferred') ?? usable[0];
  return claim ? coordinateValue(claim) : null;
}

function coordinateValue(
  claim: Record<string, unknown>,
): { latitude: number; longitude: number; globe: unknown } | null {
  const snak = claim.mainsnak;
  const value = isRecord(snak) && isRecord(snak.datavalue) ? snak.datavalue.value : undefined;
  if (!isRecord(value)) return null;
  const { latitude, longitude, globe } = value;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  return { latitude, longitude, globe };
}

/**
 * Итог проверки по ответу `Special:EntityData/{Q}.json` (разобранный JSON). Сущность — единственная
 * в `entities` (у перенаправленного номера ключ — номер цели). Порядок проверок задаёт причину:
 * сначала координаты и их границы, затем совпадение названия.
 */
export function checkWikidataEntity(
  body: unknown,
  input: WorldGeoInput,
): { point: WorldGeoPoint | null; reason: WorldGeoReason | null } {
  const entities = isRecord(body) && isRecord(body.entities) ? Object.values(body.entities) : [];
  const entity = entities.length === 1 ? entities[0] : undefined;
  if (!isRecord(entity) || 'missing' in entity) return { point: null, reason: 'not_found' };
  const coordinate = coordinateOf(entity);
  if (!coordinate) return { point: null, reason: 'no_coordinates' };
  if (coordinate.globe !== WIKIDATA_EARTH) return { point: null, reason: 'not_earth' };
  const { latitude: lat, longitude: lng } = coordinate;
  if (
    !(Number.isFinite(lat) && Number.isFinite(lng)) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return { point: null, reason: 'out_of_range' };
  }
  const ours = new Set(input.names.map((n) => foldMention(n).trim()));
  if (!wikidataNames(entity, input.language).some((n) => ours.has(foldMention(n).trim()))) {
    return { point: null, reason: 'name_mismatch' };
  }
  return { point: { lat, lng }, reason: null };
}

/** Колонка `geo` как есть: только целая запись нашей формы, иначе `null` (форму стережёт запись). */
export function readGeo(value: unknown): StoredWorldGeo | null {
  if (!isRecord(value) || typeof value.wikidataId !== 'string') return null;
  if (typeof value.checkedFor !== 'string' || typeof value.checkedAt !== 'string') return null;
  if (typeof value.language !== 'string') return null;
  const reason = (WORLD_GEO_REASONS as readonly unknown[]).includes(value.reason)
    ? (value.reason as WorldGeoReason)
    : null;
  const p = value.point;
  const point =
    isRecord(p) && typeof p.lat === 'number' && typeof p.lng === 'number'
      ? { lat: p.lat, lng: p.lng }
      : null;
  if (point === null && reason === null) return null;
  return {
    wikidataId: value.wikidataId,
    checkedFor: value.checkedFor,
    language: value.language,
    checkedAt: value.checkedAt,
    point,
    reason: point ? null : reason,
  };
}

/**
 * Точка читателю (`tech.md` §11): только проверенная и только для **текущего** входа — номера
 * Wikidata и названий места (отпечаток `checkedFor`). Номер или названия сменили, а проверка ещё
 * не прошла (Wikidata не ответила, проверку оборвала порция), — точки нет: подпись Wikidata не
 * сверена с новым названием (решение арбитра `F08 | F08-12` Q2).
 */
export function publicPoint(
  geo: StoredWorldGeo | null,
  entity: WorldGeoSubject,
): { lat: number; lng: number; sourceUrl: string } | null {
  const current = currentGeo(geo, entity);
  if (!current?.point) return null;
  return { ...current.point, sourceUrl: wikidataPageUrl(current.wikidataId) };
}

/** Поля сущности, из которых строится вход проверки (`geoInputOf`). */
export interface WorldGeoSubject {
  type: string;
  kind: string | null;
  wikidataId: string | null;
  name: string | null;
  aliases: readonly string[] | null;
}

/**
 * Итог проверки, если он для **текущего** входа сущности (тот же отпечаток `checkedFor`); иначе
 * `null`. Одно правило на точку читателю (`publicPoint`) и итог редактору (`geoCheckOf`).
 */
export function currentGeo(
  geo: StoredWorldGeo | null,
  subject: WorldGeoSubject,
): StoredWorldGeo | null {
  if (!geo) return null;
  const input = geoInputOf(subject, geo.language);
  return input && geoFingerprint(input) === geo.checkedFor ? geo : null;
}
