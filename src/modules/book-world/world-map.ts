/**
 * Раскладка литературной карты (`F08-12d`, решения арбитра `F08 | F08-12` Q3, Q7 и `F08 | F08-12d`):
 * мозаика тайлов OSM одного масштаба (Web Mercator, тайл 256 px) и точки в процентах от мозаики.
 * Только числа: ни запросов, ни хранилища - их делает `WorldMapService`.
 *
 * - Общая карта книги - сетка до 4×3 = 12 тайлов (потолок на ответ), наибольший масштаб, при котором
 *   все точки помещаются с полем, вниз до z=1 (на z=1 мир - 2×2 тайла, помещается всё): блок есть
 *   всегда, когда есть хоть одна точка.
 * - Малая карта места - свой масштаб z=12, окно 2×2 = 4 тайла, точка во внутреннем квадрате окна.
 *
 * Переход через антимеридиан не поддерживается: окно не заворачивается, точки по обе стороны
 * линии смены дат дают мельче масштаб.
 */

export const WORLD_MAP_TILE_PX = 256;
/** Наибольшая сетка общей карты - потолок тайлов на ответ (решение `F08 | F08-12d` П4). */
export const WORLD_MAP_GRID = { cols: 4, rows: 3 } as const;
/** Наибольший масштаб общей карты: одна точка или точки одного квартала - масштаб малой карты. */
export const WORLD_MAP_MAX_ZOOM = 12;
export const WORLD_MAP_MIN_ZOOM = 1;
/** Поле вокруг крайних точек общей карты, px: точка не ложится на край мозаики. */
export const WORLD_MAP_MARGIN_PX = 32;
/** Малая карта места (решение `F08 | F08-12d` П4). */
export const PLACE_MAP = { zoom: 12, cols: 2, rows: 2 } as const;
/** Широта, на которой квадрат Web Mercator кончается. */
export const MERCATOR_MAX_LAT = 85.05112878;

export interface WorldMapPointInput {
  key: string;
  lat: number;
  lng: number;
}

export interface WorldMapTileRef {
  col: number;
  row: number;
  z: number;
  x: number;
  y: number;
}

export interface WorldMapLayout {
  zoom: number;
  cols: number;
  rows: number;
  tiles: WorldMapTileRef[];
  /** Положение точки в процентах ширины и высоты мозаики (0-100), два знака после запятой. */
  points: { key: string; left: number; top: number }[];
}

/** Место списка или страницы: ключ, тип и проверенная точка (`publicPoint`). */
interface MapCandidate {
  key: string;
  type?: string;
  point: { lat: number; lng: number } | null;
}

/**
 * Точки общей карты - места с точкой, в порядке списка. Кому точка положена (только реальное место
 * с проверенной Wikidata), решает одно правило - `publicPoint` (`world-geo.ts`): здесь оно
 * не повторяется, иначе карта и карточка места разошлись бы при его смене.
 */
export function bookMapPoints(places: readonly MapCandidate[]): WorldMapPointInput[] {
  return places.flatMap((p) =>
    p.point ? [{ key: p.key, lat: p.point.lat, lng: p.point.lng }] : [],
  );
}

/** Точка малой карты: место с точкой (`publicPoint`); у героя и пары точки нет - карты нет. */
export function placeMapPoint(entity: MapCandidate): WorldMapPointInput | null {
  if (entity.type !== 'place' || !entity.point) return null;
  return { key: entity.key, lat: entity.point.lat, lng: entity.point.lng };
}

/** Пиксель мира на масштабе `z` (0 … 256·2^z): x - восток, y - юг. */
export function projectMercator(lat: number, lng: number, z: number): { x: number; y: number } {
  const size = WORLD_MAP_TILE_PX * 2 ** z;
  const phi = (Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * Math.PI) / 180;
  const x = ((lng + 180) / 360) * size;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * size;
  // Долгота 180 и полюс дают ровно `size` - последний пиксель, а не первый за краем мира.
  return { x: Math.min(x, size - 1e-6), y: Math.min(Math.max(y, 0), size - 1e-6) };
}

/** Общая карта книги; точек нет - карты нет. */
export function bookMapLayout(points: readonly WorldMapPointInput[]): WorldMapLayout | null {
  if (points.length === 0) return null;
  for (let z = WORLD_MAP_MAX_ZOOM; z >= WORLD_MAP_MIN_ZOOM; z--) {
    const tilesPerSide = 2 ** z;
    const cols = Math.min(WORLD_MAP_GRID.cols, tilesPerSide);
    const rows = Math.min(WORLD_MAP_GRID.rows, tilesPerSide);
    const px = points.map((p) => projectMercator(p.lat, p.lng, z));
    // На наименьшем масштабе сетка - весь мир: поле не требуется, помещается любая точка.
    const margin = z === WORLD_MAP_MIN_ZOOM ? 0 : WORLD_MAP_MARGIN_PX;
    const x = spanOf(
      px.map((p) => p.x),
      margin,
      cols,
      tilesPerSide,
    );
    const y = spanOf(
      px.map((p) => p.y),
      margin,
      rows,
      tilesPerSide,
    );
    if (x === null || y === null) continue;
    return layoutAt(z, cols, rows, x, y, points, px);
  }
  return null;
}

/** Малая карта одного места: окно 2×2 на z=12, точка не ближе четверти окна к краю. */
export function placeMapLayout(point: WorldMapPointInput): WorldMapLayout {
  const { zoom, cols, rows } = PLACE_MAP;
  const tilesPerSide = 2 ** zoom;
  const p = projectMercator(point.lat, point.lng, zoom);
  const clamp = (v: number, n: number) => Math.max(0, Math.min(tilesPerSide - n, v));
  const x0 = clamp(Math.round(p.x / WORLD_MAP_TILE_PX) - 1, cols);
  const y0 = clamp(Math.round(p.y / WORLD_MAP_TILE_PX) - 1, rows);
  return layoutAt(zoom, cols, rows, x0, y0, [point], [p]);
}

/**
 * Первый тайл окна по оси, если точки с полем помещаются в `n` тайлов; иначе `null`. Свободные
 * тайлы делятся поровну по обе стороны, окно не выходит за край мира.
 */
function spanOf(values: number[], margin: number, n: number, tilesPerSide: number): number | null {
  // Поле за краем мира тайла не добавляет: такого тайла нет, а окно и так прижмётся к краю.
  const first = Math.max(0, Math.floor((Math.min(...values) - margin) / WORLD_MAP_TILE_PX));
  const last = Math.min(
    tilesPerSide - 1,
    Math.floor((Math.max(...values) + margin) / WORLD_MAP_TILE_PX),
  );
  const needed = last - first + 1;
  if (needed > n) return null;
  const start = first - Math.floor((n - needed) / 2);
  return Math.max(0, Math.min(tilesPerSide - n, start));
}

function layoutAt(
  z: number,
  cols: number,
  rows: number,
  x0: number,
  y0: number,
  points: readonly WorldMapPointInput[],
  px: readonly { x: number; y: number }[],
): WorldMapLayout {
  const tiles: WorldMapTileRef[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) tiles.push({ col, row, z, x: x0 + col, y: y0 + row });
  }
  const percent = (v: number) => Math.round(v * 10_000) / 100;
  return {
    zoom: z,
    cols,
    rows,
    tiles,
    points: points.map((p, i) => ({
      key: p.key,
      left: percent((px[i].x - x0 * WORLD_MAP_TILE_PX) / (cols * WORLD_MAP_TILE_PX)),
      top: percent((px[i].y - y0 * WORLD_MAP_TILE_PX) / (rows * WORLD_MAP_TILE_PX)),
    })),
  };
}
