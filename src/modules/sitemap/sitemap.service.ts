import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Language, PublicationStatus } from '@prisma/client';
import { generateRobotsTxt } from '../seo/robots/generateRobotsTxt';
import { generateSitemapIndex } from '../seo/sitemap/generateSitemapIndex';
import { getCanonicalUrl } from '../seo/canonical/getCanonicalUrl';

@Injectable()
export class SitemapService {
  private cache = new Map<string, { body: string; contentType: string; expires: number }>();
  private ttlMs: number;

  constructor(private prisma: PrismaService) {
    const raw = process.env.SITEMAP_CACHE_TTL_MS;
    const parsed = raw ? Number(raw) : NaN;
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 1000; // 60s default
  }

  private getCache(key: string) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit;
    if (hit) this.cache.delete(key);
    return undefined;
  }

  private setCache(key: string, value: { body: string; contentType: string }) {
    this.cache.set(key, { ...value, expires: Date.now() + this.ttlMs });
  }

  robots(): { body: string; contentType: string } {
    const cacheKey = 'robots.txt';
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const body = generateRobotsTxt();
    const value = { body, contentType: 'text/plain; charset=utf-8' };
    this.setCache(cacheKey, value);
    return value;
  }

  sitemapIndex(): { body: string; contentType: string } {
    const cacheKey = 'sitemap.xml';
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const langs = Object.values(Language);
    const paths = langs.map((lang) => `/sitemap-${lang}.xml`);
    const xml = generateSitemapIndex(paths);

    const value = { body: xml, contentType: 'application/xml; charset=utf-8' };
    this.setCache(cacheKey, value);
    return value;
  }

  async perLanguage(lang: Language): Promise<{ body: string; contentType: string }> {
    const cacheKey = `sitemap-${lang}.xml`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Pages (published) for this lang
    const pages = await this.prisma.page.findMany({
      where: { status: 'published', language: lang },
      select: { slug: true, updatedAt: true },
    });

    // Books (published versions for this lang)
    const versions = await this.prisma.bookVersion.findMany({
      where: { status: PublicationStatus.published, language: lang },
      select: { slug: true, updatedAt: true, publishedAt: true },
    });

    // Categories (type=category) translations for this lang
    const categoryTranslations = await this.prisma.categoryTranslation.findMany({
      where: { language: lang, category: { type: 'category' } },
      select: { slug: true, updatedAt: true },
    });

    // Genres (type=genre) translations for this lang
    const genreTranslations = await this.prisma.categoryTranslation.findMany({
      where: { language: lang, category: { type: 'genre' } },
      select: { slug: true, updatedAt: true },
    });

    // Tags translations for this lang
    const tagTranslations = await this.prisma.tagTranslation.findMany({
      where: { language: lang },
      select: { slug: true, updatedAt: true },
    });

    const urls: string[] = [];

    const addUrlNode = (loc: string, lastmod: Date) => {
      const dateStr = lastmod.toISOString();
      urls.push(
        ['  <url>', `    <loc>${loc}</loc>`, `    <lastmod>${dateStr}</lastmod>`, '  </url>'].join(
          '\n',
        ),
      );
    };

    // 1. Static Layout pages
    const now = new Date();
    addUrlNode(getCanonicalUrl('static', '', lang), now);
    addUrlNode(getCanonicalUrl('static', 'catalog', lang), now);
    addUrlNode(getCanonicalUrl('static', 'categories', lang), now);
    addUrlNode(getCanonicalUrl('static', 'genres', lang), now);
    addUrlNode(getCanonicalUrl('static', 'tags', lang), now);

    // 2. CMS Pages
    for (const p of pages) {
      addUrlNode(getCanonicalUrl('page', p.slug, lang), p.updatedAt);
    }

    // 3. Books
    for (const v of versions) {
      if (v.slug) {
        addUrlNode(getCanonicalUrl('book', v.slug, lang), v.updatedAt || v.publishedAt || now);
      }
    }

    // 4. Categories
    for (const c of categoryTranslations) {
      addUrlNode(getCanonicalUrl('category', c.slug, lang), c.updatedAt || now);
    }

    // 5. Genres
    for (const g of genreTranslations) {
      addUrlNode(getCanonicalUrl('genre', g.slug, lang), g.updatedAt || now);
    }

    // 6. Tags
    for (const t of tagTranslations) {
      addUrlNode(getCanonicalUrl('tag', t.slug, lang), t.updatedAt || now);
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls,
      '</urlset>',
      '',
    ].join('\n');

    const value = { body: xml, contentType: 'application/xml; charset=utf-8' };
    this.setCache(cacheKey, value);
    return value;
  }
}
