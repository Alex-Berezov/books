import type { PrismaService } from '../../prisma/prisma.service';
import type { StorageService } from '../../shared/storage/storage.interface';
import { solidPng, type OsmTileClient, type OsmTileResult } from './osm-tile.client';
import {
  WORLD_MAP_BREAKER_MS,
  WORLD_MAP_MIN_TTL_MS,
  WORLD_MAP_STALE_GRACE_MS,
  WorldMapService,
  ttlMs,
} from './world-map.service';

type Row = {
  z: number;
  x: number;
  y: number;
  storageKey: string;
  prevStorageKey: string | null;
  etag: string | null;
  expiresAt: Date;
  fetchedAt: Date;
};
type At = { z: number; x: number; y: number };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-27T00:00:00Z');
const png = solidPng(256, 256, [9, 9, 9]);
const png2 = solidPng(256, 256, [8, 8, 8]);
const png3 = solidPng(256, 256, [7, 7, 7]);
const SPB = { key: 'spb', lat: 59.9375, lng: 30.3086 };
const ok = (bytes = png, etag: string | null = '"e1"', maxAgeSec: number | null = null) =>
  ({ kind: 'ok', bytes, etag, maxAgeSec }) as const;

/**
 * Подставная таблица повторяет условия записи Postgres: `createMany` без дублей пишет только
 * отсутствующую строку, `updateMany` - только строку с названным `storageKey`; `count` - сколько
 * строк задето. Хранилище помнит живые объекты: адрес удалённого объекта - битая картинка.
 */
function setup() {
  const rows = new Map<string, Row>();
  const id = (a: At) => `${a.z}/${a.x}/${a.y}`;
  const objects = new Set<string>();
  const prisma = {
    worldMapTile: {
      findMany: jest.fn(({ where }: { where: { OR: At[] } }) =>
        Promise.resolve(
          where.OR.flatMap((a) => (rows.has(id(a)) ? [{ ...rows.get(id(a))! }] : [])),
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { z_x_y: At } }) =>
        Promise.resolve(rows.get(id(where.z_x_y)) ?? null),
      ),
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        let count = 0;
        for (const r of data) {
          if (rows.has(id(r))) continue;
          rows.set(id(r), { ...r });
          count++;
        }
        return Promise.resolve({ count });
      }),
      updateMany: jest.fn(
        ({ where, data }: { where: At & { storageKey: string }; data: Partial<Row> }) => {
          const row = rows.get(id(where));
          if (!row || row.storageKey !== where.storageKey) return Promise.resolve({ count: 0 });
          rows.set(id(where), { ...row, ...data });
          return Promise.resolve({ count: 1 });
        },
      ),
    },
  };
  const storage = {
    save: jest.fn((key: string) => {
      objects.add(key);
      return Promise.resolve(key);
    }),
    delete: jest.fn((key: string) => {
      objects.delete(key);
      return Promise.resolve();
    }),
    getPublicUrl: (key: string) => `https://media.example/${key}`,
  };
  let next: (z: number, x: number, y: number, etag: string | null) => OsmTileResult = () => ok();
  const tile = jest.fn((z: number, x: number, y: number, etag: string | null) =>
    Promise.resolve(next(z, x, y, etag)),
  );
  let now = T0;
  const service = new WorldMapService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    { tile } as unknown as OsmTileClient,
    () => now,
  );
  const keyOf = (url: string) => url.replace('https://media.example/', '');
  return {
    service,
    rows,
    objects,
    storage,
    tile,
    prisma,
    keyOf,
    setNext: (fn: typeof next) => (next = fn),
    setNow: (t: number) => (now = t),
  };
}

describe('WorldMapService (F08-12d)', () => {
  it('первый запрос качает 4 тайла малой карты, кладёт их в хранилище и отдаёт адреса хранилища', async () => {
    const s = setup();
    const map = await s.service.buildPlaceMap(SPB);
    expect(map).not.toBeNull();
    expect(map!.tiles).toHaveLength(4);
    expect(s.tile).toHaveBeenCalledTimes(4);
    for (const t of map!.tiles) {
      expect(t.url).toMatch(
        /^https:\/\/media\.example\/world-map\/osm\/12\/\d+\/\d+\/[0-9a-f]{16}\.png$/,
      );
      expect(s.objects.has(s.keyOf(t.url))).toBe(true);
    }
    expect(map!.points).toEqual([expect.objectContaining({ key: 'spb' })]);
    // Строки - с адресом z/x/y своего тайла; срок без заголовков - 7 дней.
    expect(s.rows.size).toBe(4);
    for (const [key, row] of s.rows) {
      expect(`${row.z}/${row.x}/${row.y}`).toBe(key);
      expect(row.storageKey.startsWith(`world-map/osm/${key}/`)).toBe(true);
      expect(row.expiresAt.getTime()).toBe(T0 + 7 * DAY);
      expect(row.prevStorageKey).toBeNull();
    }
  });

  it('строки карты читаются одним запросом, а не по запросу на тайл', async () => {
    const s = setup();
    await s.service.buildBookMap([SPB, { key: 'moscow', lat: 55.7558, lng: 37.6173 }]);
    expect(s.prisma.worldMapTile.findMany).toHaveBeenCalledTimes(1);
    expect(s.prisma.worldMapTile.findUnique).not.toHaveBeenCalled();
  });

  it('свежий тайл - без запроса к OSM', async () => {
    const s = setup();
    await s.service.buildPlaceMap(SPB);
    s.tile.mockClear();
    s.setNow(T0 + 7 * DAY - 1);
    expect(await s.service.buildPlaceMap(SPB)).not.toBeNull();
    expect(s.tile).not.toHaveBeenCalled();
  });

  it('просроченный тайл - условный запрос с ETag; 304 продлевает срок без новой записи', async () => {
    const s = setup();
    await s.service.buildPlaceMap(SPB);
    s.storage.save.mockClear();
    s.tile.mockClear();
    s.setNext(() => ({ kind: 'not_modified', maxAgeSec: 30 * 24 * 3600 }));
    s.setNow(T0 + 8 * DAY);
    const map = await s.service.buildPlaceMap(SPB);
    expect(map).not.toBeNull();
    expect(s.tile).toHaveBeenCalledTimes(4);
    expect(s.tile.mock.calls.map((c) => c[3])).toEqual(['"e1"', '"e1"', '"e1"', '"e1"']);
    expect(s.storage.save).not.toHaveBeenCalled();
    for (const row of s.rows.values()) expect(row.expiresAt.getTime()).toBe(T0 + 38 * DAY);
  });

  it('304 без строки (так OSM не отвечает) - тайла нет', async () => {
    const s = setup();
    s.setNext(() => ({ kind: 'not_modified', maxAgeSec: null }));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
  });

  it('новое содержимое - новый ключ; прежние объекты не удаляются (страницы в ISR ссылаются на них)', async () => {
    const s = setup();
    const v1 = await s.service.buildPlaceMap(SPB);
    const k1 = v1!.tiles.map((t) => s.keyOf(t.url));
    s.setNext(() => ok(png2, '"e2"', 60));
    s.setNow(T0 + 8 * DAY);
    const v2 = await s.service.buildPlaceMap(SPB);
    const k2 = v2!.tiles.map((t) => s.keyOf(t.url));
    expect(k2).not.toEqual(k1);
    for (const row of s.rows.values()) {
      expect(row.etag).toBe('"e2"');
      // max-age 60 с меньше 7 дней - берётся 7 дней.
      expect(row.expiresAt.getTime()).toBe(T0 + 15 * DAY);
      expect(k1).toContain(row.prevStorageKey);
    }
    // Вторая смена: объекты обеих прошлых смен живы - тайлы общие для книг (решение круг 3 Q2).
    s.setNext(() => ok(png3, '"e3"'));
    s.setNow(T0 + 16 * DAY);
    await s.service.buildPlaceMap(SPB);
    expect(s.storage.delete).not.toHaveBeenCalled();
    for (const k of [...k1, ...k2]) expect(s.objects.has(k)).toBe(true);
  });

  it('200 с тем же содержимым - срок продлевается, объект и ключ прежние', async () => {
    const s = setup();
    const v1 = await s.service.buildPlaceMap(SPB);
    s.storage.save.mockClear();
    s.setNext(() => ok(png, null, null));
    s.setNow(T0 + 8 * DAY);
    const v2 = await s.service.buildPlaceMap(SPB);
    expect(v2!.tiles).toEqual(v1!.tiles);
    expect(s.storage.save).not.toHaveBeenCalled();
    for (const row of s.rows.values()) expect(row.expiresAt.getTime()).toBe(T0 + 15 * DAY);
  });

  it('гонка первой загрузки: проигравший берёт строку победителя, объекты не удаляются', async () => {
    const s = setup();
    // Пока этот запрос качал тайл, другой уже записал строку с другим содержимым.
    s.setNext((z, x, y) => {
      s.rows.set(`${z}/${x}/${y}`, {
        z,
        x,
        y,
        storageKey: `world-map/osm/${z}/${x}/${y}/winner.png`,
        prevStorageKey: null,
        etag: '"w"',
        expiresAt: new Date(T0 + 7 * DAY),
        fetchedAt: new Date(T0),
      });
      s.objects.add(`world-map/osm/${z}/${x}/${y}/winner.png`);
      return ok(png2, '"mine"');
    });
    const map = await s.service.buildPlaceMap(SPB);
    expect(map).not.toBeNull();
    for (const t of map!.tiles) expect(t.url).toMatch(/\/winner\.png$/);
    // Ключ - хеш содержимого: «свой» объект мог записать сосед - сервис объекты не удаляет (круг 4).
    expect(s.storage.delete).not.toHaveBeenCalled();
  });

  it('гонка с одинаковым содержимым: тот же ключ у победителя - объект жив и отдаётся', async () => {
    const s = setup();
    // Пока этот запрос сохранял объект, сосед с теми же байтами (тот же хеш - тот же ключ) записал
    // строку: createMany без дублей вернёт 0, запрос проиграл гонку.
    s.storage.save.mockImplementation((key: string) => {
      s.objects.add(key);
      const [z, x, y] = key.split('/').slice(2, 5).map(Number);
      s.rows.set(`${z}/${x}/${y}`, {
        z,
        x,
        y,
        storageKey: key,
        prevStorageKey: null,
        etag: '"w"',
        expiresAt: new Date(T0 + 7 * DAY),
        fetchedAt: new Date(T0),
      });
      return Promise.resolve(key);
    });
    const map = await s.service.buildPlaceMap(SPB);
    expect(map).not.toBeNull();
    for (const t of map!.tiles) expect(s.objects.has(s.keyOf(t.url))).toBe(true);
    expect(s.storage.delete).not.toHaveBeenCalled();
  });

  it('гонка смены содержимого: строку уже сменил другой запрос - отдаётся его объект, ничего не удаляется', async () => {
    const s = setup();
    await s.service.buildPlaceMap(SPB);
    s.setNow(T0 + 8 * DAY);
    s.setNext((z, x, y) => {
      const id = `${z}/${x}/${y}`;
      s.rows.set(id, { ...s.rows.get(id)!, storageKey: `world-map/osm/${id}/other.png` });
      s.objects.add(`world-map/osm/${id}/other.png`);
      return ok(png2, '"mine"');
    });
    const map = await s.service.buildPlaceMap(SPB);
    for (const t of map!.tiles) expect(t.url).toMatch(/\/other\.png$/);
    expect(s.storage.delete).not.toHaveBeenCalled();
  });

  it('отказ OSM без тайла в хранилище - карты нет целиком, а не мозаика с дырой', async () => {
    const s = setup();
    let n = 0;
    s.setNext(() => (n++ === 2 ? { kind: 'unavailable', trip: false } : ok(png, null)));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
  });

  it('не PNG в ответе - тайла нет; при строке - отдаётся прежний тайл', async () => {
    const s = setup();
    s.setNext(() => ok(Buffer.from('<svg/>'), null));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    expect(s.storage.save).not.toHaveBeenCalled();

    const t = setup();
    const v1 = await t.service.buildPlaceMap(SPB);
    t.setNext(() => ok(Buffer.from('<svg/>'), null));
    t.setNow(T0 + 8 * DAY);
    expect((await t.service.buildPlaceMap(SPB))!.tiles).toEqual(v1!.tiles);
  });

  it('хранилище не приняло объект - карты нет, строки не пишутся', async () => {
    const s = setup();
    s.storage.save.mockRejectedValue(new Error('R2 down'));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    expect(s.rows.size).toBe(0);
  });

  it('упала ревалидация - устаревший тайл до 30 дней после срока, дальше карты нет', async () => {
    const s = setup();
    const v1 = await s.service.buildPlaceMap(SPB);
    s.setNext(() => ({ kind: 'unavailable', trip: false }));
    s.setNow(T0 + 7 * DAY + WORLD_MAP_STALE_GRACE_MS - 1);
    expect((await s.service.buildPlaceMap(SPB))!.tiles).toEqual(v1!.tiles);
    s.setNow(T0 + 7 * DAY + WORLD_MAP_STALE_GRACE_MS + 1);
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
  });

  it('прерыватель: отказ с trip - 5 минут без запросов к OSM, потом снова спрашиваем', async () => {
    const s = setup();
    s.setNext(() => ({ kind: 'unavailable', trip: true }));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    // Тайлы карты запрашиваются параллельно: все 4 получают отказ, прерыватель открыт для следующих.
    expect(s.tile).toHaveBeenCalledTimes(4);
    s.tile.mockClear();
    s.setNow(T0 + WORLD_MAP_BREAKER_MS - 1000);
    s.setNext(() => ok());
    // Открыт: в OSM не ходим, тайлов в хранилище нет - карты нет.
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    expect(s.tile).not.toHaveBeenCalled();
    // Закрылся: запрос идёт, карта есть.
    s.setNow(T0 + WORLD_MAP_BREAKER_MS + 1);
    expect(await s.service.buildPlaceMap(SPB)).not.toBeNull();
    expect(s.tile).toHaveBeenCalledTimes(4);
  });

  it('прерыватель открыт - просроченный тайл отдаётся из хранилища без запроса к OSM', async () => {
    const s = setup();
    const v1 = await s.service.buildPlaceMap(SPB);
    s.setNow(T0 + 8 * DAY);
    s.setNext(() => ({ kind: 'unavailable', trip: true }));
    // Ревалидация открывает прерыватель; тайлы этой карты - прежние, адресами прежних объектов.
    expect((await s.service.buildPlaceMap(SPB))!.tiles).toEqual(v1!.tiles);
    s.tile.mockClear();
    s.setNow(T0 + 8 * DAY + 60_000);
    expect((await s.service.buildPlaceMap(SPB))!.tiles).toEqual(v1!.tiles);
    expect(s.tile).not.toHaveBeenCalled();
  });

  it('тайлы карты запрашиваются параллельно - срок карты один таймаут тайла, а не сумма', async () => {
    const s = setup();
    let inFlight = 0;
    let peak = 0;
    s.tile.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return ok(png, null);
    });
    const map = await s.service.buildBookMap([SPB, { key: 'moscow', lat: 55.7558, lng: 37.6173 }]);
    expect(s.tile).toHaveBeenCalledTimes(map!.tiles.length);
    expect(peak).toBe(map!.tiles.length);
  });

  it('строка не записалась (база отказала) - карты нет, объект не удаляется', async () => {
    const s = setup();
    s.prisma.worldMapTile.createMany.mockRejectedValue(new Error('P1001'));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    expect(s.storage.delete).not.toHaveBeenCalled();
    expect(s.objects.size).toBe(4);
  });

  it('содержимое вернулось к прежнему (A→B→A), а строка не записалась - прежний объект жив', async () => {
    const s = setup();
    const v1 = await s.service.buildPlaceMap(SPB);
    const kA = v1!.tiles.map((t) => s.keyOf(t.url));
    s.setNext(() => ok(png2, '"b"'));
    s.setNow(T0 + 8 * DAY);
    await s.service.buildPlaceMap(SPB);
    // Третья смена возвращает содержимое A - его ключ сейчас prevStorageKey строки.
    s.setNext(() => ok(png, '"a"'));
    s.setNow(T0 + 16 * DAY);
    s.prisma.worldMapTile.updateMany.mockRejectedValue(new Error('P1001'));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    for (const k of kA) expect(s.objects.has(k)).toBe(true);
  });

  it('отказ без trip прерыватель не открывает', async () => {
    const s = setup();
    s.setNext(() => ({ kind: 'unavailable', trip: false }));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
    expect(s.tile).toHaveBeenCalledTimes(4);
    s.tile.mockClear();
    s.setNext(() => ok());
    expect(await s.service.buildPlaceMap(SPB)).not.toBeNull();
    expect(s.tile).toHaveBeenCalledTimes(4);
  });

  it('ошибка базы (таблицы нет) - карты нет, а не 500', async () => {
    const s = setup();
    s.prisma.worldMapTile.findMany.mockRejectedValue(new Error('relation does not exist'));
    expect(await s.service.buildPlaceMap(SPB)).toBeNull();
  });

  it('общая карта: точек нет - без запросов; потолок 12 тайлов', async () => {
    const s = setup();
    expect(await s.service.buildBookMap([])).toBeNull();
    expect(s.tile).not.toHaveBeenCalled();
    expect(s.prisma.worldMapTile.findMany).not.toHaveBeenCalled();
    const map = await s.service.buildBookMap([SPB, { key: 'moscow', lat: 55.7558, lng: 37.6173 }]);
    expect(map!.tiles.length).toBeLessThanOrEqual(12);
    expect(s.tile).toHaveBeenCalledTimes(map!.tiles.length);
  });

  it('срок хранения: заголовок сервера, но не меньше 7 дней', () => {
    expect(ttlMs(null)).toBe(WORLD_MAP_MIN_TTL_MS);
    expect(ttlMs(60)).toBe(WORLD_MAP_MIN_TTL_MS);
    expect(ttlMs(30 * 24 * 3600)).toBe(30 * DAY);
  });
});
