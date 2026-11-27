import {
  bookMapLayout,
  bookMapPoints,
  placeMapPoint,
  placeMapLayout,
  projectMercator,
  PLACE_MAP,
  WORLD_MAP_GRID,
  WORLD_MAP_MAX_ZOOM,
} from './world-map';

describe('world-map: раскладка литературной карты (F08-12d)', () => {
  describe('projectMercator', () => {
    it('z=1: (0,0) - центр мира, (-180, 85.05) - левый верхний угол', () => {
      expect(projectMercator(0, 0, 1)).toEqual({ x: 256, y: 256 });
      const corner = projectMercator(85.05112878, -180, 1);
      expect(corner.x).toBe(0);
      expect(corner.y).toBeCloseTo(0, 3);
    });

    it('восток - вправо, север - вверх: широта и долгота не перепутаны', () => {
      const p = projectMercator(60, 30, 1);
      expect(p.x).toBeCloseTo(256 + (30 / 360) * 512, 6);
      expect(p.y).toBeLessThan(256);
      // Петербург на z=10 - тайл 597/297 (формула slippy map OSM).
      const spb = projectMercator(59.9375, 30.3086, 10);
      expect([Math.floor(spb.x / 256), Math.floor(spb.y / 256)]).toEqual([598, 297]);
    });

    it('долгота 180 и широта за пределом Mercator не выходят за край мира', () => {
      const p = projectMercator(89.9, 180, 2);
      expect(p.x).toBeLessThan(1024);
      expect(p.y).toBeGreaterThanOrEqual(0);
    });
  });

  describe('bookMapLayout', () => {
    it('точек нет - карты нет', () => {
      expect(bookMapLayout([])).toBeNull();
    });

    it('одна точка - наибольший масштаб, сетка 4×3, точка внутри мозаики', () => {
      const layout = bookMapLayout([{ key: 'spb', lat: 59.9375, lng: 30.3086 }])!;
      expect(layout.zoom).toBe(WORLD_MAP_MAX_ZOOM);
      expect([layout.cols, layout.rows]).toEqual([WORLD_MAP_GRID.cols, WORLD_MAP_GRID.rows]);
      expect(layout.tiles).toHaveLength(12);
      const [pt] = layout.points;
      expect(pt.key).toBe('spb');
      expect(pt.left).toBeGreaterThan(0);
      expect(pt.left).toBeLessThan(100);
      expect(pt.top).toBeGreaterThan(0);
      expect(pt.top).toBeLessThan(100);
    });

    it('точки двух городов одной страны - мельче масштаб, но не больше 12 тайлов', () => {
      const layout = bookMapLayout([
        { key: 'spb', lat: 59.9375, lng: 30.3086 },
        { key: 'moscow', lat: 55.7558, lng: 37.6173 },
      ])!;
      expect(layout.zoom).toBeLessThan(WORLD_MAP_MAX_ZOOM);
      expect(layout.zoom).toBeGreaterThan(3);
      expect(layout.tiles.length).toBeLessThanOrEqual(12);
      for (const p of layout.points) {
        expect(p.left).toBeGreaterThanOrEqual(0);
        expect(p.left).toBeLessThanOrEqual(100);
        expect(p.top).toBeGreaterThanOrEqual(0);
        expect(p.top).toBeLessThanOrEqual(100);
      }
      // Наибольший масштаб: на следующем точки уже не помещаются в сетку.
      const next = projectMercatorSpan(layout.zoom + 1);
      expect(next.cols > WORLD_MAP_GRID.cols || next.rows > WORLD_MAP_GRID.rows).toBe(true);
    });

    it('точки от Арктики до Антарктиды - z=1, весь мир 2×2, блок есть', () => {
      const layout = bookMapLayout([
        // Север Шпицбергена и Антарктида: на z=2 широты занимают все 4 ряда, сетка - 3.
        { key: 'longyearbyen', lat: 78.2232, lng: 15.6267 },
        { key: 'mcmurdo', lat: -77.8419, lng: 166.6863 },
        { key: 'ushuaia', lat: -54.8019, lng: -68.303 },
      ])!;
      expect(layout.zoom).toBe(1);
      expect([layout.cols, layout.rows]).toEqual([2, 2]);
      expect(layout.tiles.map((t) => [t.x, t.y])).toEqual([
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]);
    });

    it('точки у края мира (поле за краем) не снижают масштаб: окно прижимается к краю', () => {
      // z=6: тайл 5,625° долготы. 160° - тайл 60, 179,99° - последний тайл 63: ровно 4 колонки.
      // Поле 32 px за правым краем мира тайла не добавляет - иначе 5 колонок и масштаб ниже (z=5).
      const layout = bookMapLayout([
        { key: 'a', lat: 0, lng: 179.99 },
        { key: 'b', lat: 0, lng: 160 },
      ])!;
      expect(layout.zoom).toBe(6);
      expect(layout.tiles.map((t) => t.x).filter((x, i, all) => all.indexOf(x) === i)).toEqual([
        60, 61, 62, 63,
      ]);
    });

    it('тайлы - сетка по строкам с адресами z/x/y подряд', () => {
      const layout = bookMapLayout([{ key: 'a', lat: 10, lng: 10 }])!;
      const first = layout.tiles[0];
      expect(layout.tiles.map((t) => [t.col, t.row, t.x - first.x, t.y - first.y])).toEqual(
        [0, 1, 2].flatMap((row) => [0, 1, 2, 3].map((col) => [col, row, col, row])),
      );
    });
  });

  describe('placeMapLayout', () => {
    it('у края мира окно прижато к краю: тайлы только в пределах мира, точка внутри мозаики', () => {
      const n = 2 ** PLACE_MAP.zoom;
      for (const point of [
        { key: 'east', lat: 0, lng: 179.999 },
        { key: 'west', lat: 0, lng: -179.999 },
        { key: 'north', lat: 85, lng: 0 },
      ]) {
        const layout = placeMapLayout(point);
        for (const t of layout.tiles) {
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(t.x).toBeLessThan(n);
          expect(t.y).toBeGreaterThanOrEqual(0);
          expect(t.y).toBeLessThan(n);
        }
        const [pt] = layout.points;
        expect(pt.left).toBeGreaterThanOrEqual(0);
        expect(pt.left).toBeLessThanOrEqual(100);
        expect(pt.top).toBeGreaterThanOrEqual(0);
        expect(pt.top).toBeLessThanOrEqual(100);
      }
    });

    it('z=12, окно 2×2, точка во внутреннем квадрате', () => {
      const layout = placeMapLayout({ key: 'spb', lat: 59.9375, lng: 30.3086 });
      expect([layout.zoom, layout.cols, layout.rows]).toEqual([
        PLACE_MAP.zoom,
        PLACE_MAP.cols,
        PLACE_MAP.rows,
      ]);
      expect(layout.tiles).toHaveLength(4);
      const [pt] = layout.points;
      expect(pt.left).toBeGreaterThanOrEqual(25);
      expect(pt.left).toBeLessThanOrEqual(75);
      expect(pt.top).toBeGreaterThanOrEqual(25);
      expect(pt.top).toBeLessThanOrEqual(75);
    });
  });
});

/** Сколько тайлов занимают две точки теста выше с полем 32 px на масштабе `z`. */
function projectMercatorSpan(z: number) {
  const a = projectMercator(59.9375, 30.3086, z);
  const b = projectMercator(55.7558, 37.6173, z);
  const tiles = (u: number, v: number) =>
    Math.floor((Math.max(u, v) + 32) / 256) - Math.floor((Math.min(u, v) - 32) / 256) + 1;
  return { cols: tiles(a.x, b.x), rows: tiles(a.y, b.y) };
}

describe('world-map: отбор точек (F08-12d)', () => {
  const pt = { lat: 59.9, lng: 30.3 };
  it('общая карта - места с точкой (её даёт только publicPoint), порядок списка', () => {
    expect(
      bookMapPoints([
        { key: 'a', point: pt },
        { key: 'b', point: null },
        { key: 'e', point: { lat: 1, lng: 2 } },
      ]),
    ).toEqual([
      { key: 'a', ...pt },
      { key: 'e', lat: 1, lng: 2 },
    ]);
    expect(bookMapPoints([])).toEqual([]);
  });

  it('малая карта - только место с точкой', () => {
    expect(placeMapPoint({ key: 'a', type: 'place', point: pt })).toEqual({ key: 'a', ...pt });
    expect(placeMapPoint({ key: 'a', type: 'place', point: null })).toBeNull();
    expect(placeMapPoint({ key: 'a', type: 'character', point: pt })).toBeNull();
  });
});
