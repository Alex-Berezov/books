import { isAddressAllowed } from './source-fetch-address';

describe('isAddressAllowed', () => {
  // По одному адресу из каждого запрещённого диапазона и по одному за его границей (должен проходить).
  const blockedIpv4: Array<[string, string, string]> = [
    ['0.0.0.0/8', '0.1.2.3', '1.0.0.1'],
    ['10.0.0.0/8', '10.255.0.1', '11.0.0.1'],
    ['100.64.0.0/10', '100.64.0.1', '100.128.0.1'],
    ['127.0.0.0/8', '127.0.0.1', '128.0.0.1'],
    ['169.254.0.0/16', '169.254.169.254', '169.255.0.1'],
    ['172.16.0.0/12', '172.31.255.1', '172.32.0.1'],
    ['192.0.0.0/24', '192.0.0.8', '192.0.1.1'],
    ['192.168.0.0/16', '192.168.1.1', '192.169.0.1'],
    ['198.18.0.0/15', '198.19.255.1', '198.20.0.1'],
    ['224.0.0.0/4', '239.255.255.250', '223.255.255.1'],
    ['240.0.0.0/4', '240.0.0.1', '223.0.0.1'],
    ['255.255.255.255', '255.255.255.255', '8.8.8.8'],
    ['192.0.2.0/24', '192.0.2.10', '192.0.3.10'],
    ['198.51.100.0/24', '198.51.100.7', '198.51.101.7'],
    ['203.0.113.0/24', '203.0.113.9', '203.0.114.9'],
  ];

  it.each(blockedIpv4)('IPv4 %s: запрещён внутри диапазона', (_range, inside) => {
    expect(isAddressAllowed(inside)).toBe(false);
  });

  it.each(blockedIpv4)('IPv4 %s: за границей диапазона допустим', (_range, _inside, outside) => {
    // Ловит расширение диапазона: запрет не должен задевать соседей.
    expect(isAddressAllowed(outside)).toBe(true);
  });

  it('публичные IPv4 допустимы', () => {
    expect(isAddressAllowed('8.8.8.8')).toBe(true);
    expect(isAddressAllowed('93.184.216.34')).toBe(true);
  });

  const blockedIpv6: Array<[string, string]> = [
    ['::', '::'],
    ['::1', '::1'],
    ['fc00::/7', 'fd12:3456::1'],
    ['fe80::/10', 'fe80::1'],
    ['fec0::/10', 'fec0::1'],
    ['ff00::/8', 'ff02::1'],
    ['::/96 (IPv4-compatible)', '::7f00:1'],
    ['64:ff9b::/96 (NAT64)', '64:ff9b::7f00:1'],
    ['64:ff9b:1::/48 (NAT64 local)', '64:ff9b:1::1'],
    ['2002::/16 (6to4)', '2002:7f00:1::1'],
    ['2001::/32 (Teredo)', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
    ['100::/64', '100::1'],
    ['2001:db8::/32', '2001:db8::1'],
  ];

  it.each(blockedIpv6)('IPv6 %s: запрещён', (_range, address) => {
    expect(isAddressAllowed(address)).toBe(false);
  });

  it('IPv6 вне 2000::/3 запрещён, даже если его нет в списке', () => {
    expect(isAddressAllowed('4000::1')).toBe(false);
    expect(isAddressAllowed('8000::1')).toBe(false);
    expect(isAddressAllowed('1fff::1')).toBe(false);
  });

  it('публичный IPv6 из 2000::/3 допустим', () => {
    expect(isAddressAllowed('2606:4700:4700::1111')).toBe(true);
    expect(isAddressAllowed('2a00:1450:4001:81b::200e')).toBe(true);
  });

  it('IPv4-mapped: судит вложенный IPv4, в любой записи', () => {
    expect(isAddressAllowed('::ffff:127.0.0.1')).toBe(false);
    expect(isAddressAllowed('::ffff:7f00:1')).toBe(false);
    expect(isAddressAllowed('0:0:0:0:0:ffff:10.0.0.1')).toBe(false);
    expect(isAddressAllowed('::ffff:100.64.0.1')).toBe(false);
    expect(isAddressAllowed('::ffff:8.8.8.8')).toBe(true);
  });

  it('мусор вместо адреса не допускается', () => {
    expect(isAddressAllowed('')).toBe(false);
    expect(isAddressAllowed('example.com')).toBe(false);
    expect(isAddressAllowed('999.1.1.1')).toBe(false);
  });

  it('зона у link-local не обходит запрет', () => {
    expect(isAddressAllowed('fe80::1%eth0')).toBe(false);
  });
});
