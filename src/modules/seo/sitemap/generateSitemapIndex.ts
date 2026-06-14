import { buildAbsoluteUrl } from '../utils/buildAbsoluteUrl';

export function generateSitemapIndex(sitemapPaths: string[]): string {
  const urls = sitemapPaths.map((p) => buildAbsoluteUrl(p));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <sitemap><loc>${u}</loc></sitemap>`),
    '</sitemapindex>',
    '',
  ].join('\n');
}
