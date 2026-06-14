import { getCanonicalUrl } from '../canonical/getCanonicalUrl';

export interface GenreSitemapItem {
  slug: string;
  language: string;
  lastmod: Date;
}

export function generateGenreSitemaps(items: GenreSitemapItem[]): string {
  const urls = items.map((item) => {
    const loc = getCanonicalUrl('category', item.slug, item.language);
    const dateStr = item.lastmod.toISOString();
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${dateStr}</lastmod>`,
      '  </url>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
