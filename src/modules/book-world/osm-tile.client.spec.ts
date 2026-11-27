import { Logger } from '@nestjs/common';
import { sniffImage } from '../../shared/image/image-check';
import {
  maxAgeOf,
  OSM_TILE_STUB_ENV,
  OSM_TILE_USER_AGENT,
  OsmTileClient,
  osmTileUrl,
  solidPng,
} from './osm-tile.client';

const png = solidPng(256, 256, [1, 2, 3]);

describe('OsmTileClient (F08-12d)', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = (respond: () => Response | Promise<Response>) =>
    new OsmTileClient((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    });
  beforeEach(() => {
    calls.length = 0;
  });

  it('адрес - постоянный хост OSM из целых z/x/y в границах масштаба', () => {
    expect(osmTileUrl(12, 2393, 1190)).toBe('https://tile.openstreetmap.org/12/2393/1190.png');
    expect(osmTileUrl(1, 2, 0)).toBeNull();
    expect(osmTileUrl(1, 0, -1)).toBeNull();
    expect(osmTileUrl(1.5, 0, 0)).toBeNull();
    expect(osmTileUrl(20, 0, 0)).toBeNull();
  });

  it('свой User-Agent с контактом, Referer сайта, без no-cache; ETag - условным запросом', async () => {
    const res = await client(
      () =>
        new Response(new Uint8Array(png), {
          status: 200,
          headers: { etag: '"a1"', 'cache-control': 'max-age=86400' },
        }),
    ).tile(3, 4, 2, '"old"');
    expect(res).toEqual({ kind: 'ok', bytes: png, etag: '"a1"', maxAgeSec: 86400 });
    const headers = new Headers(calls[0].init.headers);
    expect(calls[0].url).toBe('https://tile.openstreetmap.org/3/4/2.png');
    expect(headers.get('user-agent')).toBe(OSM_TILE_USER_AGENT);
    expect(OSM_TILE_USER_AGENT).toMatch(/support@bibliaris\.com/);
    expect(headers.get('referer')).toBe('https://bibliaris.com/');
    expect(headers.get('if-none-match')).toBe('"old"');
    expect(headers.get('cache-control')).toBeNull();
    expect(headers.get('pragma')).toBeNull();
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('без ETag заголовка If-None-Match нет', async () => {
    await client(() => new Response(new Uint8Array(png), { status: 200 })).tile(1, 0, 0, null);
    expect(new Headers(calls[0].init.headers).get('if-none-match')).toBeNull();
  });

  it('304 - not_modified со сроком сервера', async () => {
    const res = await client(
      () => new Response(null, { status: 304, headers: { 'cache-control': 'max-age=60' } }),
    ).tile(1, 0, 0, '"a"');
    expect(res).toEqual({ kind: 'not_modified', maxAgeSec: 60 });
  });

  it.each([500, 503, 403, 429])('HTTP %i - отказ, открывающий прерыватель', async (status) => {
    expect(await client(() => new Response('', { status })).tile(1, 0, 0, null)).toEqual({
      kind: 'unavailable',
      trip: true,
    });
  });

  it('404 - отказ без прерывателя', async () => {
    expect(await client(() => new Response('', { status: 404 })).tile(1, 0, 0, null)).toEqual({
      kind: 'unavailable',
      trip: false,
    });
  });

  it('таймаут и сетевая ошибка - отказ с прерывателем, а не исключение', async () => {
    const timeout = new OsmTileClient(() =>
      Promise.reject(new DOMException('The operation was aborted', 'TimeoutError')),
    );
    expect(await timeout.tile(1, 0, 0, null)).toEqual({ kind: 'unavailable', trip: true });
    const network = new OsmTileClient(() => Promise.reject(new TypeError('fetch failed')));
    expect(await network.tile(1, 0, 0, null)).toEqual({ kind: 'unavailable', trip: true });
  });

  it('ответ больше предела - отказ', async () => {
    const res = await client(
      () =>
        new Response(new Uint8Array(png), {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024) },
        }),
    ).tile(1, 0, 0, null);
    expect(res).toEqual({ kind: 'unavailable', trip: false });
  });

  it('переход 3xx (сменился хост) - отказ без прерывателя, за переходом не идём', async () => {
    const res = await client(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } }),
    ).tile(1, 0, 0, null);
    expect(res).toEqual({ kind: 'unavailable', trip: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('поток сверх предела без content-length - чтение обрывается, отказ', async () => {
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // До 100 кусков по 256 КБ (25 МБ) при пределе 512 КБ: после третьего чтение обрывается.
        if (sent++ < 100) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await client(() => new Response(body, { status: 200 })).tile(1, 0, 0, null);
    expect(res).toEqual({ kind: 'unavailable', trip: false });
    expect(sent).toBeLessThan(10);
  });

  it('адрес вне масштаба - отказ без запроса', async () => {
    expect(await client(() => new Response('')).tile(1, 5, 0, null)).toEqual({
      kind: 'unavailable',
      trip: false,
    });
    expect(calls).toHaveLength(0);
  });

  describe('подставной транспорт (Р5)', () => {
    const saved = process.env[OSM_TILE_STUB_ENV];
    const realFetch = global.fetch;
    afterEach(() => {
      if (saved === undefined) delete process.env[OSM_TILE_STUB_ENV];
      else process.env[OSM_TILE_STUB_ENV] = saved;
      global.fetch = realFetch;
    });

    it('подставка включена - предупреждение в журнал; без неё и с тестовым транспортом - нет', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        process.env[OSM_TILE_STUB_ENV] = 'png';
        new OsmTileClient();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(OSM_TILE_STUB_ENV);
        warn.mockClear();
        new OsmTileClient(() => Promise.resolve(new Response('')));
        delete process.env[OSM_TILE_STUB_ENV];
        new OsmTileClient();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('без переменной клиент ходит на tile.openstreetmap.org глобальным fetch', async () => {
      delete process.env[OSM_TILE_STUB_ENV];
      const seen: string[] = [];
      global.fetch = ((url: string) => {
        seen.push(url);
        return Promise.resolve(new Response(new Uint8Array(png), { status: 200 }));
      }) as typeof fetch;
      const res = await new OsmTileClient().tile(2, 1, 1, null);
      expect(seen).toEqual(['https://tile.openstreetmap.org/2/1/1.png']);
      expect(res.kind).toBe('ok');
    });

    it('другое значение переменной подставной транспорт не включает', async () => {
      process.env[OSM_TILE_STUB_ENV] = '1';
      const seen: string[] = [];
      global.fetch = ((url: string) => {
        seen.push(url);
        return Promise.resolve(new Response('', { status: 503 }));
      }) as typeof fetch;
      await new OsmTileClient().tile(2, 1, 1, null);
      expect(seen).toEqual(['https://tile.openstreetmap.org/2/1/1.png']);
    });

    it('значение png - серый PNG 256×256 без сети, повтор с ETag - 304', async () => {
      process.env[OSM_TILE_STUB_ENV] = 'png';
      global.fetch = (() => Promise.reject(new Error('network'))) as typeof fetch;
      const stub = new OsmTileClient();
      const first = await stub.tile(2, 1, 1, null);
      if (first.kind !== 'ok') throw new Error(`expected ok, got ${first.kind}`);
      expect(sniffImage(first.bytes)).toMatchObject({ mime: 'image/png', width: 256, height: 256 });
      expect(await stub.tile(2, 1, 1, first.etag)).toEqual({
        kind: 'not_modified',
        maxAgeSec: 604800,
      });
    });
  });
});

describe('maxAgeOf', () => {
  const at = Date.parse('2026-11-27T00:00:00Z');
  it('max-age и s-maxage из Cache-Control', () => {
    expect(maxAgeOf(new Headers({ 'cache-control': 'public, max-age=3600' }), at)).toBe(3600);
    expect(maxAgeOf(new Headers({ 'cache-control': 's-maxage=10' }), at)).toBe(10);
  });
  it('Expires относительно Date; ничего - null', () => {
    const headers = new Headers({
      date: 'Fri, 27 Nov 2026 00:00:00 GMT',
      expires: 'Fri, 27 Nov 2026 01:00:00 GMT',
    });
    expect(maxAgeOf(headers, at)).toBe(3600);
    expect(maxAgeOf(new Headers(), at)).toBeNull();
  });
});
