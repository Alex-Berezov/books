import {
  DEFAULT_TRUSTED_PROXY_CIDRS,
  isTrustedProxy,
  parseTrustedProxyCidrs,
  resetClientIpWarning,
  resolveClientIp,
} from './client-ip';

/**
 * LEGACY-064 / LEGACY-077.
 *
 * Смысл этих посадок — не «заголовок читается», а **кому он верится**. Пока origin
 * принимал прямые соединения, `CF-Connecting-IP` подставлялся одной строкой `curl`,
 * и лимитер, доверяющий заголовку от кого угодно, обходится тривиально. Проверка
 * источника здесь — второй рубеж к правилу файрвола, а не замена ему.
 */
const CF_PEER = '104.21.3.171'; // из 104.16.0.0/13
const CF_PEER_V6 = '2606:4700::1';
const STRANGER = '203.0.113.7';

describe('resolveClientIp', () => {
  beforeEach(() => {
    resetClientIpWarning();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('takes the visitor address from CF-Connecting-IP when the peer is Cloudflare', () => {
    const ip = resolveClientIp(
      { ip: CF_PEER, headers: { 'cf-connecting-ip': '198.51.100.42' } },
      DEFAULT_TRUSTED_PROXY_CIDRS,
    );
    expect(ip).toBe('198.51.100.42');
  });

  it('does the same over IPv6', () => {
    const ip = resolveClientIp(
      { ip: CF_PEER_V6, headers: { 'cf-connecting-ip': '2001:db8::99' } },
      DEFAULT_TRUSTED_PROXY_CIDRS,
    );
    expect(ip).toBe('2001:db8::99');
  });

  // 🔴 Главная посадка. Без неё лимит обходится подстановкой заголовка: каждый
  // запрос объявляет себя новым посетителем и получает свежую корзину.
  it('ignores the header from a peer that is not Cloudflare', () => {
    const ip = resolveClientIp(
      { ip: STRANGER, headers: { 'cf-connecting-ip': '198.51.100.42' } },
      DEFAULT_TRUSTED_PROXY_CIDRS,
    );
    expect(ip).toBe(STRANGER);
  });

  it('says so in the log when it ignores a header — a stale range list looks the same', () => {
    resolveClientIp(
      { ip: STRANGER, headers: { 'cf-connecting-ip': '198.51.100.42' } },
      DEFAULT_TRUSTED_PROXY_CIDRS,
    );
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back to the peer when the header is absent', () => {
    expect(resolveClientIp({ ip: CF_PEER, headers: {} }, DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(
      CF_PEER,
    );
  });

  it('refuses a header that is not an address at all', () => {
    const ip = resolveClientIp(
      { ip: CF_PEER, headers: { 'cf-connecting-ip': 'not-an-ip; drop table' } },
      DEFAULT_TRUSTED_PROXY_CIDRS,
    );
    expect(ip).toBe(CF_PEER);
  });

  it('never fails closed: an unknown peer still yields a key', () => {
    // Лимитер обязан деградировать до более грубого счёта, а не начинать отбивать
    // трафик, если что-то в этой цепочке не сошлось.
    expect(resolveClientIp({}, DEFAULT_TRUSTED_PROXY_CIDRS)).toBe('unknown');
  });
});

describe('trusted proxy ranges', () => {
  it('recognises Cloudflare ranges and rejects the rest', () => {
    expect(isTrustedProxy(CF_PEER, DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(true);
    expect(isTrustedProxy(CF_PEER_V6, DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(true);
    expect(isTrustedProxy(STRANGER, DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(false);
    expect(isTrustedProxy('127.0.0.1', DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(false);
  });

  it('can be overridden from the environment so a range change needs no deploy', () => {
    const custom = parseTrustedProxyCidrs('10.0.0.0/8, 2001:db8::/32');
    expect(isTrustedProxy('10.1.2.3', custom)).toBe(true);
    expect(isTrustedProxy(CF_PEER, custom)).toBe(false);
  });

  it('falls back to the built-in list when the variable is empty or blank', () => {
    expect(parseTrustedProxyCidrs(undefined)).toBe(DEFAULT_TRUSTED_PROXY_CIDRS);
    expect(parseTrustedProxyCidrs('   ')).toBe(DEFAULT_TRUSTED_PROXY_CIDRS);
  });
});
