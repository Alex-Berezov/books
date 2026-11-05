import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:https';

export type SourceFetchFailure =
  | 'URL_INVALID'
  | 'ADDRESS_BLOCKED'
  | 'REDIRECTS'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'CONTENT_TYPE'
  | 'HTTP_STATUS'
  | 'NETWORK'
  /** Имени нет (`ENOTFOUND`, `ENODATA`): сервер имён ответил, что такого хоста нет. Это свойство адреса, а не канала. */
  | 'NAME_UNKNOWN'
  /** Сертификат не прошёл проверку (`CERT_*`, `ERR_TLS_*`, самоподписанный): свойство сервера, а не канала. */
  | 'TLS'
  /** Сервер источника отверг или оборвал соединение (`ECONNREFUSED`, `ECONNRESET`…): свойство сервера, а не канала. */
  | 'CONNECTION';

export interface SourceFetchResult {
  ok: boolean;
  /** Хост последнего запрошенного адреса (после переходов); пусто, если адрес не разобрался. */
  host: string;
  status: number | null;
  reason: SourceFetchFailure | null;
  /** Текст страницы без тегов, обрезанный по длине; при отказе пустой. */
  text: string;
}

/** Замена `dns.lookup(host, { all: true })`: все адреса имени. */
export type SourceFetchResolver = (hostname: string) => Promise<LookupAddress[]>;

/**
 * Тестовые крюки. Токена нет в боевой сборке (провайдер подключает только тест), поэтому
 * обойти запреты в проде нельзя. Читаются один раз в конструкторе сервиса.
 */
export interface SourceFetchTestHooks {
  /** Подмена резолвера; ответ всё равно проходит проверку запрещённых адресов. */
  lookup?: SourceFetchResolver;
  /** Опции `https.request` (ca, агент и т.п.); `lookup`, хост и путь они не перекрывают. */
  requestOptions?: RequestOptions;
  /** Дополнительный разрешённый порт (локальный HTTPS-сервер теста). */
  allowPort?: number;
  /**
   * Явно пропустить проверку запрещённых адресов (127.0.0.1 тестового сервера):
   * `true` - для всех имён, массив - только для перечисленных имён хостов.
   */
  allowBlockedAddresses?: boolean | readonly string[];
  /** Таймаут цепочки, мс, вместо 10 с (иначе тест таймаута шёл бы 10 секунд). */
  timeoutMs?: number;
}

export const SOURCE_FETCH_TEST_HOOKS = Symbol('SOURCE_FETCH_TEST_HOOKS');
