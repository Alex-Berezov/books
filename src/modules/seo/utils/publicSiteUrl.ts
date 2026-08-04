/**
 * Single source of truth for the PUBLIC site origin used in SEO output
 * (canonical, hreflang, og:url, JSON-LD, robots.txt, sitemap).
 *
 * It must never be derived from a service host. `LOCAL_PUBLIC_BASE_URL` and
 * `R2_PUBLIC_BASE_URL` describe where *files* are served from (api./media.
 * subdomains) and are unrelated to where *pages* live. Mixing them leaked
 * `https://api.bibliaris.com/{lang}/tag/{slug}` into canonical/hreflang and got
 * those URLs discovered by Google (see tasks/tz-seo-subdomain-leak.md).
 */

export const PUBLIC_SITE_URL_ENV = 'PUBLIC_SITE_URL';

/** Used only when PUBLIC_SITE_URL is not set — always a public page host, never a service host. */
export const DEFAULT_PUBLIC_SITE_URL = 'https://bibliaris.com';

/** Host prefixes that can never serve public HTML pages. */
const SERVICE_HOST_PREFIXES = ['api.', 'media.', 'cdn.', 'static.', 'assets.'];

export interface PublicSiteUrlEnv {
  PUBLIC_SITE_URL?: string;
  LOCAL_PUBLIC_BASE_URL?: string;
  R2_PUBLIC_BASE_URL?: string;
  // Index signature keeps `process.env` (NodeJS.ProcessEnv) assignable to this type.
  [key: string]: string | undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return stripTrailingSlash(a) === stripTrailingSlash(b);
  }
}

/**
 * Validate PUBLIC_SITE_URL. Throws on a value that would leak a service host
 * into the public markup. Returns silently when the variable is unset — the
 * hardcoded {@link DEFAULT_PUBLIC_SITE_URL} is used in that case, and it is by
 * construction safe.
 */
export function assertPublicSiteUrl(env: PublicSiteUrlEnv = process.env): void {
  const raw = env.PUBLIC_SITE_URL?.trim();
  if (!raw) return;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${PUBLIC_SITE_URL_ENV} is not a valid absolute URL: "${raw}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${PUBLIC_SITE_URL_ENV} must use http(s), got "${parsed.protocol}"`);
  }

  const host = parsed.hostname.toLowerCase();
  const badPrefix = SERVICE_HOST_PREFIXES.find((prefix) => host.startsWith(prefix));
  if (badPrefix) {
    throw new Error(
      `${PUBLIC_SITE_URL_ENV}="${raw}" points at the service host "${host}". ` +
        'It must be the public site origin (canonical/hreflang/og:url/JSON-LD are built from it). ' +
        'Use LOCAL_PUBLIC_BASE_URL / R2_PUBLIC_BASE_URL for file links instead.',
    );
  }

  for (const name of ['LOCAL_PUBLIC_BASE_URL', 'R2_PUBLIC_BASE_URL'] as const) {
    const other = env[name]?.trim();
    if (other && sameOrigin(raw, other)) {
      throw new Error(
        `${PUBLIC_SITE_URL_ENV} must not equal ${name} ("${other}"). ` +
          'Public page URLs and file URLs are different origins.',
      );
    }
  }
}

/** Resolve the public site origin, without a trailing slash. */
export function resolvePublicSiteUrl(env: PublicSiteUrlEnv = process.env): string {
  const raw = env.PUBLIC_SITE_URL?.trim();
  if (!raw) return DEFAULT_PUBLIC_SITE_URL;
  return stripTrailingSlash(raw);
}
