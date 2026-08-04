import type { NextFunction, Request, Response } from 'express';

/**
 * The API subdomain must never be indexed: it serves JSON, not pages.
 *
 * `X-Robots-Tag: noindex` is used instead of `robots.txt: Disallow: /` on
 * purpose — the frontend issues client-side requests to this host, and blocking
 * crawling would stop Googlebot from rendering the site. The header forbids
 * indexing without forbidding fetching.
 *
 * `/static/*` is excluded: with the local storage driver book covers are served
 * from there, and `noindex` would remove them from Google Images.
 */
const INDEXABLE_PREFIXES = ['/static/'];

export function robotsHeaderMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path || req.url || '';
  const isStaticAsset = INDEXABLE_PREFIXES.some((prefix) => path.startsWith(prefix));

  if (!isStaticAsset) {
    res.setHeader('X-Robots-Tag', 'noindex');
  }

  next();
}
