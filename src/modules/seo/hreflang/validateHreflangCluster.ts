import { HreflangLink } from './generateHreflangLinks';

export function validateHreflangCluster(links: HreflangLink[]): boolean {
  if (links.length === 0) return true;

  const hasXDefault = links.some((link) => link.hreflang === 'x-default');
  const hasAlternates = links.some((link) => link.hreflang !== 'x-default');
  const allValid = links.every((link) => typeof link.href === 'string' && link.href.length > 0);

  return allValid && (links.length === 1 || (hasXDefault && hasAlternates));
}
