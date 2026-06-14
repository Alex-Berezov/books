import { getCanonicalUrl } from '../canonical/getCanonicalUrl';

export interface BookSitemapItem {
  slug: string;
  language: string;
  lastmod: Date;
}

export function generateBookSitemaps(items: BookSitemapItem[]): string {
  const urls = items.map((item) => {
    const loc = getCanonicalUrl('book', item.slug, item.language);
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
