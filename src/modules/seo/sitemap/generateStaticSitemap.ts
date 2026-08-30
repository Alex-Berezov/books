import { getCanonicalUrl, CanonicalPathType } from '../canonical/getCanonicalUrl';

export interface StaticSitemapItem {
  // `LEGACY-319`: подмножество словаря адресов, а не своя копия литералов.
  type: Extract<CanonicalPathType, 'page' | 'static'>;
  slug: string;
  language: string;
  lastmod: Date;
}

export function generateStaticSitemap(items: StaticSitemapItem[]): string {
  const urls = items.map((item) => {
    const loc = getCanonicalUrl(item.type, item.slug, item.language);
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
