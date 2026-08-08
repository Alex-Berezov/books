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

/**
 * Адрес, по которому считать лимит.
 *
 * Возвращает `CF-Connecting-IP`, если запрос пришёл из доверенного диапазона;
 * иначе — `req.ip`. Отсутствие доверия никогда не приводит к отказу: лимитер
 * должен деградировать до более грубого счёта, а не начинать отбивать трафик.
 */
export function resolveClientIp(req: ClientIpRequest, cidrs: string[]): string {
  const peer = req.ip ?? 'unknown';
  const rawHeader = req.headers?.['cf-connecting-ip'];
  const candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

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
  return trimmed;
}
