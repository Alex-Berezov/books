import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { crc32, deflateSync } from 'node:zlib';
import { readLimitedBytes } from '../../shared/http/read-limited';

/**
 * Узкий клиент тайлов OpenStreetMap (`F08-12d`, решение арбитра `F08 | F08-12d`): один постоянный
 * хост и один адрес `/{z}/{x}/{y}.png` из целых чисел в границах масштаба - адрес из входа
 * не собирается. Политика тайлов OSM (operations.osmfoundation.org/policies/tiles/): свой
 * User-Agent с контактом, без `no-cache`, условный запрос по ETag; зовёт клиент только
 * `WorldMapService` по запросу страницы с картой - упреждающей выборки нет.
 *
 * Итог: `ok` (байты, ETag, срок сервера), `not_modified` (304 на `If-None-Match`) или
 * `unavailable`; `trip` - отказ, после которого OSM не спрашивают какое-то время (таймаут, сеть,
 * 5xx, 403, 429: решение `F08 | F08-12d` Р6).
 */

export const OSM_TILE_HOST = 'tile.openstreetmap.org';
export const OSM_TILE_TIMEOUT_MS = 3_000;
/** Тайл OSM - десятки килобайт; больше - не тайл. */
export const OSM_TILE_MAX_BYTES = 512 * 1024;
export const OSM_TILE_MAX_ZOOM = 19;
// Имя, версия и контакт проекта - правило User-Agent политики OSM; контакт тот же, что у Wikidata
// (`WIKIDATA_USER_AGENT`), ручная копия `contactGeneral` фронта: копии перечислены в строке
// `lib/site/owner-contacts.ts` файла `books-app-docs/ai-context/folder-structure.md`.
export const OSM_TILE_USER_AGENT =
  'BibliarisMap/1.0 (https://bibliaris.com; support@bibliaris.com)';
/** Страница, ради которой взят тайл: политика просит не вычищать Referer. */
export const OSM_TILE_REFERER = 'https://bibliaris.com/';
/**
 * Подставной транспорт (решение `F08 | F08-12d` Р5): только явным значением `png` - контейнер
 * бэкенда в CI фронта отдаёт одну и ту же серую картинку и не ходит в живой OSM. Без переменной
 * (и при любом другом значении) клиент ходит на `tile.openstreetmap.org`.
 */
export const OSM_TILE_STUB_ENV = 'WORLD_MAP_TILE_STUB';

export type OsmTileResult =
  | { kind: 'ok'; bytes: Buffer; etag: string | null; maxAgeSec: number | null }
  | { kind: 'not_modified'; maxAgeSec: number | null }
  | { kind: 'unavailable'; trip: boolean };

export type OsmTileFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Тестовый транспорт - аргументом конструктора, как у `WikidataClient`; в модуле не объявлен. */
const OSM_TILE_TEST_FETCH = Symbol('OSM_TILE_TEST_FETCH');

export function osmTileUrl(z: number, x: number, y: number): string | null {
  if (![z, x, y].every(Number.isInteger)) return null;
  if (z < 0 || z > OSM_TILE_MAX_ZOOM) return null;
  const n = 2 ** z;
  if (x < 0 || x >= n || y < 0 || y >= n) return null;
  return `https://${OSM_TILE_HOST}/${z}/${x}/${y}.png`;
}

@Injectable()
export class OsmTileClient {
  private readonly logger = new Logger(OsmTileClient.name);
  private readonly fetchImpl: OsmTileFetch;

  constructor(@Optional() @Inject(OSM_TILE_TEST_FETCH) testFetch?: OsmTileFetch) {
    const stub = !testFetch && process.env[OSM_TILE_STUB_ENV] === 'png';
    // Подставные тайлы на живой машине легли бы в хранилище на 7 дней: включение видно в журнале.
    if (stub)
      this.logger.warn(`${OSM_TILE_STUB_ENV}=png: map tiles are stubbed, OSM is not called`);
    this.fetchImpl = testFetch ?? (stub ? stubTileFetch : (url, init) => fetch(url, init));
  }

  async tile(z: number, x: number, y: number, etag: string | null): Promise<OsmTileResult> {
    const url = osmTileUrl(z, x, y);
    if (!url) return { kind: 'unavailable', trip: false };
    try {
      const res = await this.fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(OSM_TILE_TIMEOUT_MS),
        headers: {
          'User-Agent': OSM_TILE_USER_AGENT,
          Referer: OSM_TILE_REFERER,
          Accept: 'image/png',
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      });
      const maxAgeSec = maxAgeOf(res.headers);
      if (res.status === 304) {
        await res.body?.cancel();
        return { kind: 'not_modified', maxAgeSec };
      }
      if (!res.ok) {
        await res.body?.cancel();
        const trip = res.status >= 500 || res.status === 403 || res.status === 429;
        this.logger.warn(`OSM tile ${z}/${x}/${y}: HTTP ${res.status}`);
        return { kind: 'unavailable', trip };
      }
      const bytes = await readLimitedBytes(res, OSM_TILE_MAX_BYTES);
      if (!bytes) return { kind: 'unavailable', trip: false };
      return { kind: 'ok', bytes, etag: res.headers.get('etag'), maxAgeSec };
    } catch (error) {
      this.logger.warn(`OSM tile ${z}/${x}/${y}: ${error instanceof Error ? error.name : 'error'}`);
      return { kind: 'unavailable', trip: true };
    }
  }
}

/**
 * Срок свежести от сервера, секунд: `Cache-Control: max-age` (или `s-maxage`), иначе `Expires`
 * относительно `Date`; нет ни того, ни другого - `null` (сервис берёт наименьший срок).
 */
export function maxAgeOf(headers: Headers, now: number = Date.now()): number | null {
  const cc = headers.get('cache-control') ?? '';
  const m = /(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)"?/i.exec(cc);
  if (m) return Number(m[1]);
  const expires = headers.get('expires');
  if (!expires) return null;
  const at = Date.parse(expires);
  if (!Number.isFinite(at)) return null;
  const date = Date.parse(headers.get('date') ?? '');
  const base = Number.isFinite(date) ? date : now;
  return Math.max(0, Math.round((at - base) / 1000));
}

let stubPng: Buffer | null = null;

/** Подставной ответ: серый PNG 256×256, ETag постоянный - ревалидация даёт 304. */
const stubTileFetch: OsmTileFetch = (_url, init) => {
  const etag = '"bibliaris-stub-tile"';
  const cacheControl = 'max-age=604800';
  const sent = new Headers(init.headers).get('if-none-match');
  if (sent === etag) {
    return Promise.resolve(
      new Response(null, { status: 304, headers: { 'cache-control': cacheControl } }),
    );
  }
  stubPng ??= solidPng(256, 256, [0xdd, 0xdd, 0xdd]);
  return Promise.resolve(
    new Response(new Uint8Array(stubPng), {
      status: 200,
      headers: { 'content-type': 'image/png', etag, 'cache-control': cacheControl },
    }),
  );
};

/** PNG одного цвета (RGB, 8 бит) без зависимостей: заголовок, сжатые строки, конец. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let i = 0; i < width; i++) row.set(rgb, 1 + i * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
