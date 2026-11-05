import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import * as dns from 'node:dns';
import * as https from 'node:https';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip } from 'node:zlib';

import { isAddressAllowed } from './source-fetch-address';
import { htmlToText, plainToText } from './source-fetch-html';
import { normalizeSourceUrl, parseSourceUrl } from './source-fetch-url';
import {
  SOURCE_FETCH_TEST_HOOKS,
  type SourceFetchFailure,
  type SourceFetchResolver,
  type SourceFetchResult,
  type SourceFetchTestHooks,
} from './source-fetch.types';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const MAX_PARALLEL = 4;
// Таймаут общий на всю цепочку переходов: так сумма не растёт с числом переходов.
export const CHAIN_TIMEOUT_MS = 10_000;

const ALLOWED_MIME = new Set(['text/html', 'text/plain']);

class SourceFetchError extends Error {
  constructor(
    readonly reason: SourceFetchFailure,
    readonly status: number | null = null,
  ) {
    super(reason);
  }
}

interface HopResponse {
  status: number;
  /** Адрес перехода, если ответ 3xx с Location. */
  location: string | null;
  body: Buffer;
  contentType: string;
  charset: string;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | dns.LookupAddress[],
  family?: number,
) => void;

const defaultResolver: SourceFetchResolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true });

/**
 * Функция `lookup` для сокета: имя разрешается один раз, запрещённые адреса отбрасываются,
 * сокету уходит только проверенное. Повторного разрешения нет, поэтому rebinding не сработает.
 * Две формы ответа: Node с autoSelectFamily зовёт с `all: true` и ждёт массив.
 */
export function createCheckedLookup(
  resolve: SourceFetchResolver,
  isAllowed: (address: string, hostname: string) => boolean,
) {
  return (hostname: string, options: unknown, callback?: LookupCallback): void => {
    const done = (typeof options === 'function' ? options : callback) as LookupCallback;
    const wantsAll =
      typeof options === 'object' && options !== null && 'all' in options
        ? Boolean((options as { all?: boolean }).all)
        : false;
    resolve(hostname).then(
      (addresses) => {
        const allowed = addresses.filter((entry) => isAllowed(entry.address, hostname));
        if (allowed.length === 0) {
          done(Object.assign(new SourceFetchError('ADDRESS_BLOCKED'), { code: 'EBLOCKED' }));
          return;
        }
        if (wantsAll) done(null, allowed);
        else done(null, allowed[0].address, allowed[0].family);
      },
      (error: NodeJS.ErrnoException) => done(error),
    );
  };
}

@Injectable()
export class SourceFetcherService {
  private readonly logger = new Logger(SourceFetcherService.name);
  private readonly hooks: SourceFetchTestHooks;

  // Крюки читаются один раз: менять поведение уже созданного сервиса нельзя.
  constructor(@Optional() @Inject(SOURCE_FETCH_TEST_HOOKS) hooks?: SourceFetchTestHooks) {
    this.hooks = { ...(hooks ?? {}) };
  }

  /** Страница одним запросом (с переходами). Никогда не бросает: отказ — `ok: false` с причиной. */
  async fetchPage(url: string): Promise<SourceFetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.hooks.timeoutMs ?? CHAIN_TIMEOUT_MS);
    let host = '';
    try {
      let current = this.parse(url);
      for (let redirects = 0; ; redirects += 1) {
        host = current.hostname;
        const response = await this.requestOnce(current, controller.signal);
        if (response.location !== null) {
          if (redirects >= MAX_REDIRECTS) throw new SourceFetchError('REDIRECTS', response.status);
          // Каждый переход проходит все проверки заново, включая адрес в lookup.
          current = this.parse(this.resolveLocation(response.location, current));
          continue;
        }
        const text = this.toText(response);
        this.logger.log(`host=${host} status=${response.status}`);
        return { ok: true, host, status: response.status, reason: null, text };
      }
    } catch (error) {
      const failure = error instanceof SourceFetchError ? error : new SourceFetchError('NETWORK');
      const reason = controller.signal.aborted ? 'TIMEOUT' : failure.reason;
      this.logger.warn(`host=${host} reason=${reason}`);
      return { ok: false, host, status: failure.status, reason, text: '' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Несколько адресов с параллелизмом не больше 4. Кэш хода передаёт вызывающий:
   * один нормализованный адрес — один запрос, в том числе среди дублей внутри списка.
   */
  async fetchMany(
    urls: string[],
    cache: Map<string, SourceFetchResult> = new Map(),
  ): Promise<SourceFetchResult[]> {
    const inflight = new Map<string, Promise<SourceFetchResult>>();
    const results: SourceFetchResult[] = new Array<SourceFetchResult>(urls.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < urls.length) {
        const index = next;
        next += 1;
        const key = normalizeSourceUrl(urls[index], this.hooks.allowPort);
        const cached = cache.get(key);
        if (cached) {
          results[index] = cached;
          continue;
        }
        let pending = inflight.get(key);
        if (!pending) {
          pending = this.fetchPage(urls[index]);
          inflight.set(key, pending);
        }
        const result = await pending;
        cache.set(key, result);
        results[index] = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, urls.length) }, worker));
    return results;
  }

  /** Боевая политика адресов; только тестовые крюки могут её ослабить, и то явно. */
  private addressPolicy(): (address: string, hostname: string) => boolean {
    const exemption = this.hooks.allowBlockedAddresses;
    if (exemption === true) return () => true;
    if (Array.isArray(exemption)) {
      return (address, hostname) => exemption.includes(hostname) || isAddressAllowed(address);
    }
    return (address) => isAddressAllowed(address);
  }

  private parse(raw: string): URL {
    const parsed = parseSourceUrl(raw, this.hooks.allowPort);
    if (!parsed) throw new SourceFetchError('URL_INVALID');
    return parsed;
  }

  private resolveLocation(location: string, base: URL): string {
    try {
      return new URL(location, base).href;
    } catch {
      throw new SourceFetchError('URL_INVALID');
    }
  }

  private toText(response: HopResponse): string {
    let decoded: string;
    try {
      decoded = new TextDecoder(response.charset).decode(response.body);
    } catch {
      decoded = response.body.toString('utf8');
    }
    return response.contentType === 'text/html' ? htmlToText(decoded) : plainToText(decoded);
  }

  private requestOnce(url: URL, signal: AbortSignal): Promise<HopResponse> {
    const resolve = this.hooks.lookup ?? defaultResolver;
    const isAllowed = this.addressPolicy();
    const lookup = createCheckedLookup(resolve, isAllowed);

    return new Promise<HopResponse>((resolvePromise, rejectPromise) => {
      let isSettled = false;
      const settle = (error: Error | null, value?: HopResponse) => {
        if (isSettled) return;
        isSettled = true;
        if (error) rejectPromise(error);
        else resolvePromise(value as HopResponse);
      };

      const request = https.request(
        {
          agent: false,
          ...this.hooks.requestOptions,
          method: 'GET',
          protocol: 'https:',
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          // Имя остаётся и в SNI, и в Host: сертификат проверяется по имени, а не по адресу.
          servername: url.hostname,
          headers: {
            Host: url.host,
            Accept: 'text/html, text/plain;q=0.9',
            'Accept-Encoding': 'gzip, br',
            'User-Agent': 'BibliarisSourceFetcher/1.0',
          },
          lookup: lookup as unknown as https.RequestOptions['lookup'],
          signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const fail = (reason: SourceFetchFailure) => {
            res.destroy();
            settle(new SourceFetchError(reason, status));
          };

          if (status >= 300 && status < 400) {
            const location = res.headers.location;
            res.destroy();
            if (!location) settle(new SourceFetchError('HTTP_STATUS', status));
            else
              settle(null, {
                status,
                location,
                body: Buffer.alloc(0),
                contentType: '',
                charset: 'utf-8',
              });
            return;
          }
          if (status < 200 || status >= 300) return fail('HTTP_STATUS');

          const [mime, ...params] = (res.headers['content-type'] ?? '').split(';');
          const contentType = mime.trim().toLowerCase();
          if (!ALLOWED_MIME.has(contentType)) return fail('CONTENT_TYPE');
          const charset =
            params
              .map((param) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(param)?.[1])
              .find(Boolean) ?? 'utf-8';

          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail('TOO_LARGE');

          const encoding = (res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
          let stream: Readable = res;
          if (encoding === 'gzip') stream = res.pipe(createGunzip());
          else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
          else if (encoding !== 'identity' && encoding !== '') return fail('CONTENT_TYPE');

          const chunks: Buffer[] = [];
          let rawBytes = 0;
          let decodedBytes = 0;
          const abortBody = (reason: SourceFetchFailure) => {
            stream.destroy();
            fail(reason);
          };
          // Сжатый поток тоже ограничен: иначе бесконечный gzip кормил бы декомпрессор без конца.
          res.on('data', (chunk: Buffer) => {
            rawBytes += chunk.length;
            if (rawBytes > MAX_BODY_BYTES) abortBody('TOO_LARGE');
          });
          // Считаем распакованные байты потоком и обрываем: так zip-бомба не разворачивается в памяти.
          stream.on('data', (chunk: Buffer) => {
            decodedBytes += chunk.length;
            if (decodedBytes > MAX_BODY_BYTES) abortBody('TOO_LARGE');
            else chunks.push(chunk);
          });
          stream.on('end', () =>
            settle(null, {
              status,
              location: null,
              body: Buffer.concat(chunks),
              contentType,
              charset,
            }),
          );
          stream.on('error', () => fail('NETWORK'));
          res.on('error', () => fail('NETWORK'));
          // Обрыв до конца сообщения; штатный close приходит после полного ответа и ничего не ломает.
          res.on('close', () => {
            if (!res.complete) fail('NETWORK');
          });
        },
      );
      request.on('error', (error: Error) =>
        settle(error instanceof SourceFetchError ? error : cause(error)),
      );
      request.end();
    });
  }
}

/** Ошибка lookup доезжает до `request.on('error')` либо своим классом, либо обёрнутой. */
function cause(error: Error): SourceFetchError {
  if (error instanceof SourceFetchError) return error;
  const inner = (error as { cause?: unknown }).cause;
  if (inner instanceof SourceFetchError) return inner;
  return new SourceFetchError(failureOf((error as NodeJS.ErrnoException).code));
}

const NAME_UNKNOWN_CODES = new Set(['ENOTFOUND', 'ENODATA']);
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE']);
const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|HOSTNAME_MISMATCH|ERR_TLS)/;

/**
 * Причина сетевого отказа: имени нет, плохой сертификат, сервер отверг или оборвал соединение -
 * свойства адреса (источник плохой); остальное (`EAI_AGAIN`, `ENETUNREACH`…) - канал, `NETWORK`. Различие нужно
 * вызывающему: отказ канала у всех источников - не повод выбрасывать их (`sourcesOffline`).
 */
export function failureOf(code: string | undefined): SourceFetchFailure {
  if (code && NAME_UNKNOWN_CODES.has(code)) return 'NAME_UNKNOWN';
  if (code && TLS_CODE.test(code)) return 'TLS';
  if (code && CONNECTION_CODES.has(code)) return 'CONNECTION';
  return 'NETWORK';
}
