import { buildAbsoluteUrl } from '../utils/buildAbsoluteUrl';

export function generateRobotsTxt(): string {
  const sitemapUrl = buildAbsoluteUrl('/sitemap.xml');
  return (
    [
      'User-agent: *',
      'Allow: /',
      '',
      'Disallow: /api/',
      'Disallow: /admin/',
      'Disallow: /account/',
      'Disallow: /my-bookshelf',
      'Disallow: /sign-in',
      'Disallow: /sign-up',
      'Disallow: /search',
      '',
      `Sitemap: ${sitemapUrl}`,
    ].join('\n') + '\n'
  );
}
