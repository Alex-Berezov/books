import { resolvePublicSiteUrl } from './publicSiteUrl';

/**
 * Build an absolute PUBLIC page URL (canonical, hreflang, og:url, JSON-LD, sitemap).
 * Never use storage/service base URLs here — see publicSiteUrl.ts.
 */
export function buildAbsoluteUrl(path: string): string {
  const base = resolvePublicSiteUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}
