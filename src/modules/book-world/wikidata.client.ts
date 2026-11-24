import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WIKIDATA_HOST, wikidataEntityUrl } from './world-geo';
import { WIKIDATA_ID_REGEX } from './dto/book-world-blocks.dto';

/** Предел ответа: сущность крупного города в Wikidata — несколько мегабайт JSON. */
export const WIKIDATA_MAX_BYTES = 10 * 1024 * 1024;
/** Общий таймаут на всю цепочку переходов. */
export const WIKIDATA_TIMEOUT_MS = 15_000;
/** Переходы только внутри того же хоста (перенаправленная сущность). */
export const WIKIDATA_MAX_REDIRECTS = 2;
// Имя, версия и контакт проекта — правило User-Agent Wikimedia (как `SOURCE_FETCH_USER_AGENT`,
// `LEGACY-492`); контакт — ручная копия `contactGeneral` фронта (`lib/site/owner-contacts.ts`).
export const WIKIDATA_USER_AGENT =
  'BibliarisGeo/1.0 (https://bibliaris.com; support@bibliaris.com)';

export type WikidataEntityResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

export type WikidataFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Необязательный транспорт клиента: в модуле не объявлен, поэтому в работе клиент ходит глобальным
 * `fetch`. Тесты передают транспорт аргументом конструктора (`new WikidataClient(fn)`, в e2e —
 * `overrideProvider(WikidataClient)`); токен нужен только Nest для разбора параметра. Хост и путь
 * клиент собирает сам — транспорт адреса не выбирает.
 */
const WIKIDATA_TEST_FETCH = Symbol('WIKIDATA_TEST_FETCH');

/**
 * Узкий клиент Wikidata (решение арбитра `F08 | F08-12` Q2): один постоянный хост и один адрес
 * `Special:EntityData/{Q}.json`; номер проверен регуляркой, адрес из входа не собирается. Общий
 * фетчер источников (`source-fetch`) не расширяется: он берёт только HTML и текст, и JSON
 * ради одного хоста ослабил бы его поверхность для всех источников. Переход на другой хост,
 * ответ больше предела, таймаут и битый JSON — `unavailable`; 404 — `not_found`.
 */
@Injectable()
export class WikidataClient {
  private readonly logger = new Logger(WikidataClient.name);
  private readonly fetchImpl: WikidataFetch;

  constructor(@Optional() @Inject(WIKIDATA_TEST_FETCH) testFetch?: WikidataFetch) {
    this.fetchImpl = testFetch ?? ((url, init) => fetch(url, init));
  }

  async entity(id: string): Promise<WikidataEntityResult> {
    if (!WIKIDATA_ID_REGEX.test(id)) return { kind: 'not_found' };
    const signal = AbortSignal.timeout(WIKIDATA_TIMEOUT_MS);
    let url = wikidataEntityUrl(id);
    try {
      for (let hop = 0; hop <= WIKIDATA_MAX_REDIRECTS; hop++) {
        const res = await this.fetchImpl(url, {
          redirect: 'manual',
          signal,
          headers: { 'User-Agent': WIKIDATA_USER_AGENT, Accept: 'application/json' },
        });
        if (res.status >= 300 && res.status < 400) {
          const next = sameHostLocation(res.headers.get('location'), url);
          await res.body?.cancel();
          if (!next) return { kind: 'unavailable' };
          url = next;
          continue;
        }
        if (res.status === 404) {
          await res.body?.cancel();
          return { kind: 'not_found' };
        }
        if (!res.ok) {
          await res.body?.cancel();
          return { kind: 'unavailable' };
        }
        const text = await readLimited(res, WIKIDATA_MAX_BYTES);
        if (text === null) return { kind: 'unavailable' };
        return { kind: 'ok', body: JSON.parse(text) as unknown };
      }
      return { kind: 'unavailable' };
    } catch (error) {
      this.logger.warn(`Wikidata ${id}: ${error instanceof Error ? error.name : 'error'}`);
      return { kind: 'unavailable' };
    }
  }
}

/** Адрес перехода, только если он `https` на том же хосте Wikidata; иначе `null`. */
export function sameHostLocation(location: string | null, base: string): string | null {
  if (!location) return null;
  try {
    const next = new URL(location, base);
    return next.protocol === 'https:' && next.hostname === WIKIDATA_HOST ? next.toString() : null;
  } catch {
    return null;
  }
}

/** Тело ответа не больше `max` байт; больше — `null` (чтение обрывается, а не дочитывается). */
async function readLimited(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
