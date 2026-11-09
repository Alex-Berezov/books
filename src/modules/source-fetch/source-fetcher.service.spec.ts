import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { LookupAddress } from 'node:dns';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { isAddressAllowed } from './source-fetch-address';
import { TEST_TLS_CERT, TEST_TLS_KEY } from '../../common/testing/source-fetch-tls-spec';
import {
  SOURCE_FETCH_TEST_HOOKS,
  type SourceFetchResolver,
  type SourceFetchResult,
  type SourceFetchTestHooks,
} from './source-fetch.types';
import { SourceFetchModule } from './source-fetch.module';
import {
  createCheckedLookup,
  MAX_BODY_BYTES,
  SourceFetcherService,
} from './source-fetcher.service';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const LOOPBACK: LookupAddress = { address: '127.0.0.1', family: 4 };

describe('SourceFetcherService', () => {
  let server: https.Server;
  let port: number;
  let handler: Handler;

  beforeAll(async () => {
    server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) =>
      handler(req, res),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    };
  });

  afterEach(() => jest.restoreAllMocks());

  /** Сервис с резолвером, отдающим локальный сервер для имён `*.test`; 127.0.0.1 разрешён только им. */
  function makeService(extra: Partial<SourceFetchTestHooks> = {}, resolver?: SourceFetchResolver) {
    const lookup = jest.fn<ReturnType<SourceFetchResolver>, Parameters<SourceFetchResolver>>(
      resolver ?? (() => Promise.resolve([LOOPBACK])),
    );
    const service = new SourceFetcherService({
      lookup,
      requestOptions: { ca: TEST_TLS_CERT },
      allowPort: port,
      allowBlockedAddresses: ['source.test', 'cache.test'],
      timeoutMs: 5000,
      ...extra,
    });
    return { service, lookup };
  }

  const url = (path = '/', host = 'source.test') => `https://${host}:${port}${path}`;

  describe('зелёный путь', () => {
    it('читает html, вырезает теги и возвращает хост и код', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><script>x()</script><h1>Привет &amp; мир</h1></html>');
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toEqual({
        ok: true,
        host: 'source.test',
        status: 200,
        reason: null,
        text: 'Привет & мир',
      });
    });

    it('шлёт имя хоста в Host и Accept-Encoding gzip, br', async () => {
      let seen: IncomingMessage['headers'] = {};
      handler = (req, res) => {
        seen = req.headers;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      };
      const { service } = makeService();
      await service.fetchPage(url());
      expect(seen.host).toBe(`source.test:${port}`);
      expect(seen['accept-encoding']).toBe('gzip, br');
    });

    it.each([
      ['gzip', gzipSync],
      ['br', brotliCompressSync],
    ])('распаковывает %s', async (encoding, compress) => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
        res.end(compress(Buffer.from('сжатый текст')));
      };
      const { service } = makeService();
      const result = await service.fetchPage(url());
      expect(result.text).toBe('сжатый текст');
    });

    it('идёт по переходам (не больше трёх) на допустимые адреса', async () => {
      handler = (req, res) => {
        const step = Number(req.url?.slice(1) ?? 0);
        if (step < 3) {
          res.writeHead(302, { location: `/${step + 1}` });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('конец цепочки');
        }
      };
      const { service } = makeService();
      const result = await service.fetchPage(url('/0'));
      expect(result).toMatchObject({ ok: true, text: 'конец цепочки' });
    });
  });

  describe('отказы по адресу', () => {
    it.each([
      ['IPv4-литерал', 'https://127.0.0.1/'],
      ['десятичный литерал', 'https://2130706433/'],
      ['шестнадцатеричный литерал', 'https://0x7f.1/'],
      ['IPv6-литерал', 'https://[::1]/'],
      ['http', 'http://source.test/'],
      ['порт не 443', 'https://source.test:8443/'],
      ['user@host', 'https://user@source.test/'],
      ['слишком длинный', `https://source.test/${'a'.repeat(2100)}`],
    ])('URL_INVALID: %s, до сети не доходит', async (_name, bad) => {
      const { service, lookup } = makeService();
      const result = await service.fetchPage(bad);
      expect(result).toMatchObject({ ok: false, reason: 'URL_INVALID', text: '' });
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
      ['частный адрес', '10.1.2.3'],
      ['loopback', '127.0.0.1'],
      ['CGNAT 100.64.0.1', '100.64.0.1'],
      ['link-local (метаданные облака)', '169.254.169.254'],
      ['IPv4-mapped ::ffff:127.0.0.1', '::ffff:127.0.0.1'],
      ['IPv6 вне 2000::/3', 'fd00::1'],
    ])('ADDRESS_BLOCKED: имя разрешается в %s', async (_name, address) => {
      const family = address.includes(':') ? 6 : 4;
      // Хост evil.test не в списке исключений: запрет действует как в бою.
      const { service } = makeService({}, () => Promise.resolve([{ address, family }]));
      const result = await service.fetchPage(url('/', 'evil.test'));
      expect(result).toMatchObject({ ok: false, reason: 'ADDRESS_BLOCKED', status: null });
    });

    it('если часть адресов запрещена, а часть нет, соединяется только с допустимым', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      };
      const { service } = makeService({ allowBlockedAddresses: ['source.test'] }, () =>
        Promise.resolve([{ address: '10.0.0.1', family: 4 }, LOOPBACK]),
      );
      await expect(service.fetchPage(url())).resolves.toMatchObject({ ok: true });
    });

    it('переход на имя, разрешающееся в 127.0.0.1, отбит на переходе', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { location: `https://internal.test:${port}/admin` });
        res.end();
      };
      let served = 0;
      const original = handler;
      handler = (req, res) => {
        served += 1;
        original(req, res);
      };
      const { service } = makeService();
      const result = await service.fetchPage(url());
      // Второй хост не в списке исключений, поэтому 127.0.0.1 для него запрещён.
      expect(result).toMatchObject({ ok: false, reason: 'ADDRESS_BLOCKED', host: 'internal.test' });
      expect(served).toBe(1);
    });

    it('переход на IP-литерал и на http отбит как URL_INVALID', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { location: 'https://127.0.0.1/' });
        res.end();
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'URL_INVALID' });
      handler = (_req, res) => {
        res.writeHead(302, { location: 'http://source.test/' });
        res.end();
      };
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'URL_INVALID' });
    });

    it('больше трёх переходов - REDIRECTS', async () => {
      let hits = 0;
      handler = (_req, res) => {
        hits += 1;
        res.writeHead(301, { location: `/hop${hits}` });
        res.end();
      };
      const { service } = makeService();
      const result = await service.fetchPage(url('/start'));
      expect(result).toMatchObject({ ok: false, reason: 'REDIRECTS' });
      expect(hits).toBe(4);
    });

    it('3xx без Location - HTTP_STATUS', async () => {
      handler = (_req, res) => {
        res.writeHead(302);
        res.end();
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({
        reason: 'HTTP_STATUS',
        status: 302,
      });
    });
  });

  describe('закрепление адреса', () => {
    it('сокет открыт на первый проверенный адрес, второго разрешения нет', async () => {
      let calls = 0;
      const { service, lookup } = makeService({}, () => {
        calls += 1;
        // Первый ответ - сервер теста, любой следующий - адрес, на котором никто не слушает.
        return Promise.resolve([calls === 1 ? LOOPBACK : { address: '127.0.0.2', family: 4 }]);
      });
      const result = await service.fetchPage(url());
      expect(result.ok).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    describe('createCheckedLookup', () => {
      const publicAddress: LookupAddress = { address: '8.8.8.8', family: 4 };
      const makeLookup = (answers: LookupAddress[]) => {
        const resolve = jest.fn(() => Promise.resolve(answers));
        return { resolve, lookup: createCheckedLookup(resolve, isAddressAllowed) };
      };

      it('форма с одним адресом: отдаёт строку и семейство', async () => {
        const { lookup, resolve } = makeLookup([{ address: '10.0.0.1', family: 4 }, publicAddress]);
        const answer = await new Promise<unknown[]>((done) =>
          lookup('example.com', { all: false }, (...args: unknown[]) => done(args)),
        );
        expect(answer).toEqual([null, '8.8.8.8', 4]);
        expect(resolve).toHaveBeenCalledTimes(1);
      });

      it('форма all: true: отдаёт массив только проверенных адресов', async () => {
        const { lookup, resolve } = makeLookup([
          { address: '127.0.0.1', family: 4 },
          publicAddress,
        ]);
        const answer = await new Promise<unknown[]>((done) =>
          lookup('example.com', { all: true }, (...args: unknown[]) => done(args)),
        );
        expect(answer).toEqual([null, [publicAddress]]);
        expect(resolve).toHaveBeenCalledTimes(1);
      });

      it('все адреса запрещены - ошибка в обеих формах', async () => {
        const { lookup } = makeLookup([{ address: '192.168.0.1', family: 4 }]);
        for (const options of [{ all: false }, { all: true }]) {
          const error = await new Promise<Error | null>((done) =>
            lookup('example.com', options, (failure: Error | null) => done(failure)),
          );
          expect(error).toBeInstanceOf(Error);
          expect(error?.message).toBe('ADDRESS_BLOCKED');
        }
      });

      it('ошибка резолвера пробрасывается как есть', async () => {
        const failure = Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
        const lookup = createCheckedLookup(() => Promise.reject(failure), isAddressAllowed);
        const error = await new Promise<unknown>((done) =>
          lookup('nx.test', { all: true }, (e: unknown) => done(e)),
        );
        expect(error).toBe(failure);
      });
    });
  });

  describe('размер, тип, статус, таймаут', () => {
    it('TOO_LARGE по размеру без сжатия', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.alloc(MAX_BODY_BYTES + 1024, 97));
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'TOO_LARGE' });
    });

    it('TOO_LARGE после распаковки gzip (мало байт на проводе, много после)', async () => {
      const bomb = gzipSync(Buffer.alloc(MAX_BODY_BYTES * 4, 97));
      expect(bomb.length).toBeLessThan(MAX_BODY_BYTES);
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(bomb);
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'TOO_LARGE' });
    });

    it('ровно в пределе - ещё читается', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.alloc(MAX_BODY_BYTES, 97));
      };
      const { service } = makeService();
      const result = await service.fetchPage(url());
      expect(result.ok).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(20_000);
    });

    it.each(['application/json', 'image/png', ''])('CONTENT_TYPE: %p', async (type) => {
      handler = (_req, res) => {
        res.writeHead(200, type ? { 'content-type': type } : {});
        res.end('{}');
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({
        ok: false,
        reason: 'CONTENT_TYPE',
        status: 200,
      });
    });

    it('CONTENT_TYPE на неподдерживаемом сжатии (deflate)', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' });
        res.end('x');
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'CONTENT_TYPE' });
    });

    it('HTTP_STATUS с кодом ответа', async () => {
      handler = (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('нет');
      };
      const { service } = makeService();
      await expect(service.fetchPage(url())).resolves.toMatchObject({
        reason: 'HTTP_STATUS',
        status: 404,
      });
    });

    it('TIMEOUT, если сервер молчит', async () => {
      handler = () => undefined;
      const { service } = makeService({ timeoutMs: 200 });
      await expect(service.fetchPage(url())).resolves.toMatchObject({
        ok: false,
        reason: 'TIMEOUT',
      });
    });

    it('TLS при сертификате без доверия (ca не задан): свойство сервера, а не канала', async () => {
      const { service } = makeService({ requestOptions: {} });
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'TLS' });
    });

    it('имени нет (ENOTFOUND) - NAME_UNKNOWN; временный сбой имён (EAI_AGAIN) и прочее - NETWORK', async () => {
      for (const [code, reason] of [
        ['ENOTFOUND', 'NAME_UNKNOWN'],
        ['EAI_AGAIN', 'NETWORK'],
        ['ECONNREFUSED', 'CONNECTION'],
        ['ECONNRESET', 'CONNECTION'],
        [undefined, 'NETWORK'],
      ] as const) {
        const { service } = makeService({}, () =>
          Promise.reject(Object.assign(new Error('x'), code ? { code } : {})),
        );
        await expect(service.fetchPage(url())).resolves.toMatchObject({ reason });
      }
    });
  });

  describe('fetchMany', () => {
    it('держит не больше 4 запросов одновременно', async () => {
      let active = 0;
      let peak = 0;
      handler = (_req, res) => {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
        }, 80);
      };
      const { service } = makeService();
      const urls = Array.from({ length: 10 }, (_, index) => url(`/p${index}`));
      const results = await service.fetchMany(urls);
      expect(results).toHaveLength(10);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(peak).toBe(4);
    });

    it('один адрес - один запрос: дубли и кэш хода', async () => {
      let hits = 0;
      handler = (_req, res) => {
        hits += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('кэш');
      };
      const { service } = makeService();
      const cache = new Map<string, SourceFetchResult>();
      const first = await service.fetchMany([url('/a'), url('/a#frag'), url('/a')], cache);
      expect(hits).toBe(1);
      expect(first.map((result) => result.text)).toEqual(['кэш', 'кэш', 'кэш']);
      expect(cache.size).toBe(1);
      await service.fetchMany([url('/a')], cache);
      expect(hits).toBe(1);
      await service.fetchMany([url('/b')], cache);
      expect(hits).toBe(2);
    });

    it('порядок результатов совпадает с порядком адресов, отказ не роняет остальных', async () => {
      const { service } = makeService();
      const results = await service.fetchMany([url('/ok'), 'http://nope.test/', url('/ok2')]);
      expect(results.map((result) => result.ok)).toEqual([true, false, true]);
      expect(results[1].reason).toBe('URL_INVALID');
    });
  });

  describe('журнал', () => {
    it('пишет только хост и код/причину, без адреса с параметрами и без содержимого', async () => {
      const lines: string[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
      handler = (req, res) => {
        res.writeHead(req.url?.startsWith('/bad') ? 404 : 200, {
          'content-type': req.url?.startsWith('/image') ? 'image/png' : 'text/plain',
        });
        res.end('СОДЕРЖИМОЕ-СТРАНИЦЫ');
      };
      const { service } = makeService();
      await service.fetchPage(url('/path/page?token=SECRET'));
      await service.fetchPage(url('/bad?token=SECRET'));
      // Код пишется только при отказе самого сервера: и без ответа, и при ответе 200 его нет.
      await service.fetchPage('not-a-url');
      await service.fetchPage(url('/image'));
      expect(lines).toEqual([
        'host=source.test status=200',
        'host=source.test reason=HTTP_STATUS status=404',
        'host= reason=URL_INVALID',
        'host=source.test reason=CONTENT_TYPE',
      ]);
    });
  });

  describe('заголовки', () => {
    it('User-Agent называет проект и контакт (правило Wikimedia, LEGACY-492)', async () => {
      let userAgent: string | undefined;
      handler = (req, res) => {
        userAgent = req.headers['user-agent'];
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      };
      const { service } = makeService();
      await service.fetchPage(url('/'));
      expect(userAgent).toBe(
        'BibliarisSourceFetcher/1.0 (https://bibliaris.com; support@bibliaris.com)',
      );
    });
  });

  describe('внедрение', () => {
    it('модуль экспортирует сервис, в боевой сборке токена нет', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [SourceFetchModule] }).compile();
      const service = moduleRef.get(SourceFetcherService);
      // Без крюков запреты полные: 127.0.0.1 недоступен ни по какому имени.
      await expect(service.fetchPage('https://127.0.0.1/')).resolves.toMatchObject({
        reason: 'URL_INVALID',
      });
    });

    it('тестовые крюки подставляются токеном', async () => {
      const lookup = jest.fn(() => Promise.resolve([LOOPBACK]));
      const moduleRef = await Test.createTestingModule({
        providers: [
          SourceFetcherService,
          {
            provide: SOURCE_FETCH_TEST_HOOKS,
            useValue: {
              lookup,
              requestOptions: { ca: TEST_TLS_CERT },
              allowPort: port,
              allowBlockedAddresses: true,
            } satisfies SourceFetchTestHooks,
          },
        ],
      }).compile();
      const result = await moduleRef.get(SourceFetcherService).fetchPage(url());
      expect(result.ok).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('без крюков 127.0.0.1 запрещён даже при подменённом резолвере', async () => {
      const { service } = makeService({ allowBlockedAddresses: undefined });
      await expect(service.fetchPage(url())).resolves.toMatchObject({ reason: 'ADDRESS_BLOCKED' });
    });
  });
});
