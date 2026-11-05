import { BlockList, isIP } from 'node:net';

// Запрещённые диапазоны IPv4: приватные, loopback, link-local, CGNAT, документационные, мультикаст, резерв.
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

// Запрещённые диапазоны IPv6. Многие лежат вне 2000::/3 и режутся разрешающим правилом,
// но список держим полным: он страхует от случайного расширения разрешённого блока.
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['100::', 64],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['2001::', 32],
  ['2001:db8::', 32],
];

const blockedRanges = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4) blockedRanges.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_IPV6) blockedRanges.addSubnet(network, prefix, 'ipv6');

// Разрешающее правило IPv6: только глобальный юникаст 2000::/3.
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');

/** Восемь 16-битных групп IPv6; `null`, если запись не разобралась. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((group) =>
    parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/** Вложенный IPv4 из `::ffff:a.b.c.d` (в любой записи), иначе `null`. */
function mappedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) {
    return null;
  }
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
}

/**
 * Можно ли соединяться с адресом. Правило разрешающее: нераспознанное — нельзя;
 * IPv6 — только из 2000::/3 и не из запрещённого списка; IPv4 — только не из списка.
 */
export function isAddressAllowed(address: string): boolean {
  const bare = address.split('%')[0].trim();
  const family = isIP(bare);
  if (family === 4) return !blockedRanges.check(bare, 'ipv4');
  if (family !== 6) return false;
  // Вложенный IPv4 судит сам: иначе ::ffff:127.0.0.1 прошёл бы как «чужой» IPv6.
  const nested = mappedIpv4(bare);
  if (nested) return isAddressAllowed(nested);
  return globalUnicast.check(bare, 'ipv6') && !blockedRanges.check(bare, 'ipv6');
}
