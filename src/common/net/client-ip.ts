import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Кто такой «клиент» для лимитера.
 *
 * Сайт стоит за Cloudflare, поэтому `req.ip` (с `trust proxy: 1` это последняя
 * запись `X-Forwarded-For`) — адрес **пограничного узла CF**, а не посетителя.
 * Пока лимитер считал по нему, тысячи посетителей одного PoP делили одну корзину:
 * один активный робот выбирал квоту всем остальным (LEGACY-064).
 *
 * Настоящий адрес Cloudflare кладёт в `CF-Connecting-IP`. Заголовок принимается
 * **только если запрос действительно пришёл из диапазона Cloudflare** — иначе его
 * подставит кто угодно и обойдёт лимит одной строкой. Проверка источника здесь
 * намеренно дублирует правило файрвола (`LEGACY-077`): защита, держащаяся на одном
 * рубеже, исчезает вместе с ним, а правило файрвола может быть снято при разборе
 * другой задачи и без злого умысла.
 */

/**
 * Диапазоны Cloudflare на 08.08.2026 (`cloudflare.com/ips-v4`, `ips-v6`).
 *
 * ⚠️ Список меняется — редко, но меняется. Переопределяется переменной
 * `TRUSTED_PROXY_CIDRS`, чтобы обновление не требовало выката. Устаревший список
 * не открывает дыру: заголовок перестанет приниматься, и лимитер деградирует до
 * счёта по узлу CF — как было до этой правки. Такая деградация logируется.
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/**
 * Заголовок, которым **наш собственный фронт** сообщает адрес посетителя.
 *
 * Нужен отдельный от `CF-Connecting-IP`, потому что SSR-запрос идёт через тот же
 * Cloudflare, и CF ставит там свой `CF-Connecting-IP` — адрес нашего же сервера.
 * Без этого заголовка все посетители сайта сливаются в одну корзину: страницы
 * рендерит один контейнер, и вход в аккаунт тоже выполняет он (NextAuth зовёт
 * `/auth/login` на сервере). Измерено 08.08.2026: шесть попыток входа подряд из
 * контейнера фронта — и шестая уже 429, то есть на весь сайт приходилось пять
 * попыток входа в минуту.
 */
export const VISITOR_IP_HEADER = 'x-visitor-ip';

export interface ClientIpRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

const listCache = new Map<string, BlockList>();

function buildList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const raw of cidrs) {
    const cidr = raw.trim();
    if (!cidr) continue;
    const [address, prefixText] = cidr.split('/');
    const prefix = Number(prefixText);
    if (!Number.isFinite(prefix)) continue;
    if (isIPv4(address)) list.addSubnet(address, prefix, 'ipv4');
    else if (isIPv6(address)) list.addSubnet(address, prefix, 'ipv6');
  }
  return list;
}

function listFor(cidrs: string[]): BlockList {
  const key = cidrs.join(',');
  let list = listCache.get(key);
  if (!list) {
    list = buildList(cidrs);
    listCache.set(key, list);
  }
  return list;
}

export function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_TRUSTED_PROXY_CIDRS;
  const parsed = raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_TRUSTED_PROXY_CIDRS;
}

/**
 * Адреса **нашего собственного фронта**, как их видит API после разбора
 * `CF-Connecting-IP`. Задаётся `INTERNAL_PROXY_CIDRS`; по умолчанию список пуст —
 * тогда третья ступень выключена и поведение прежнее. Пустой дефолт намеренный:
 * ошибиться здесь значит начать принимать `X-Visitor-IP` от постороннего, то есть
 * отдать обход лимита любому желающему.
 */
export function parseInternalProxyCidrs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isTrustedProxy(ip: string | undefined, cidrs: string[]): boolean {
  if (!ip) return false;
  const list = listFor(cidrs);
  if (isIPv4(ip)) return list.check(ip, 'ipv4');
  if (isIPv6(ip)) return list.check(ip, 'ipv6');
  return false;
}

let untrustedHeaderWarned = false;

export function resetClientIpWarning(): void {
  untrustedHeaderWarned = false;
}

function headerValue(req: ClientIpRequest, name: string): string | undefined {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Адрес, по которому считать лимит.
 *
 * Три ступени, каждая уже предыдущей:
 *
 * 1. `req.ip` — сосед по соединению (за `trust proxy` это то, что подставил Caddy);
 * 2. если сосед из диапазона Cloudflare — `CF-Connecting-IP`;
 * 3. если полученный так адрес принадлежит **нашему собственному фронту**
 *    (`internalCidrs`) — `X-Visitor-IP`, который тот проставляет из заголовков
 *    входящего запроса посетителя.
 *
 * Третья ступень существует потому, что SSR ходит в API за всех сразу: без неё
 * весь сайт делит одну корзину, а вход в аккаунт — пять попыток в минуту на всех.
 *
 * Отсутствие доверия **никогда** не приводит к отказу: лимитер деградирует до
 * более грубого счёта, а не начинает отбивать трафик.
 */
export interface ClientIpDescription {
  /** Адрес, по которому считать лимит. */
  ip: string;
  /**
   * Запрос сделал наш собственный фронт и **не сообщил** посетителя.
   *
   * Так выглядит рендер страницы: SSR ходит в API за всех сразу, и считать эти
   * запросы одной корзиной — значит делить квоту на весь сайт. Это и есть
   * LEGACY-064 в исходной формулировке. Ограничение для посетителей должно жить
   * на входе перед фронтом, где виден настоящий клиент.
   */
  internalWithoutVisitor: boolean;
}

export function describeClientIp(
  req: ClientIpRequest,
  cidrs: string[],
  internalCidrs: string[] = [],
): ClientIpDescription {
  const ip = resolveClientIp(req, cidrs, internalCidrs);
  const internalWithoutVisitor =
    internalCidrs.length > 0 &&
    isTrustedProxy(ip, internalCidrs) &&
    !headerValue(req, VISITOR_IP_HEADER);

  return { ip, internalWithoutVisitor };
}

export function resolveClientIp(
  req: ClientIpRequest,
  cidrs: string[],
  internalCidrs: string[] = [],
): string {
  const peer = req.ip ?? 'unknown';
  const candidate = headerValue(req, 'cf-connecting-ip');

  if (!candidate) return peer;

  if (!isTrustedProxy(peer, cidrs)) {
    // Либо кто-то пробует подставить чужой адрес, либо список диапазонов устарел
    // и заголовок перестал приниматься у настоящего трафика. Второе выглядит как
    // «лимиты вдруг стали строже» и без этой записи не отличается от первого.
    if (!untrustedHeaderWarned) {
      untrustedHeaderWarned = true;

      console.warn(
        `[client-ip] CF-Connecting-IP received from an untrusted peer (${peer}) and ignored. ` +
          'Either the Cloudflare ranges in TRUSTED_PROXY_CIDRS are stale, or someone is ' +
          'forging the header. Rate limiting falls back to the peer address.',
      );
    }
    return peer;
  }

  const trimmed = candidate.trim();
  if (!isIPv4(trimmed) && !isIPv6(trimmed)) return peer;

  // Запрос пришёл от нашего же фронта — значит за ним стоит настоящий посетитель,
  // и адрес фронта в качестве ключа объединил бы весь сайт в одну корзину.
  if (internalCidrs.length > 0 && isTrustedProxy(trimmed, internalCidrs)) {
    const visitor = headerValue(req, VISITOR_IP_HEADER)?.trim();
    if (visitor && (isIPv4(visitor) || isIPv6(visitor))) return visitor;
    // Заголовка нет — фронт ещё не выкачен или запрос не от посетителя (плановая
    // задача, прогрев). Возвращаем адрес фронта: грубее, но не отказ.
  }

  return trimmed;
}
