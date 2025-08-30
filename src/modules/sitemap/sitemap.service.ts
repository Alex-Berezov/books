import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Language, PublicationStatus } from '@prisma/client';

@Injectable()
export class SitemapService {
  private cache = new Map<string, { body: string; contentType: string; expires: number }>();
  private ttlMs: number;

  constructor(private prisma: PrismaService) {
    const raw = process.env.SITEMAP_CACHE_TTL_MS;
    const parsed = raw ? Number(raw) : NaN;
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 1000; // 60s default
  }

  private get publicBase(): string {
    return process.env.LOCAL_PUBLIC_BASE_URL || 'http://localhost:3000';
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

    const base = this.publicBase.replace(/\/$/, '');
    const lines = ['User-agent: *', 'Allow: /', `Sitemap: ${base}/sitemap.xml`];
    const body = lines.join('\n') + '\n';
    const value = { body, contentType: 'text/plain; charset=utf-8' };
    this.setCache(cacheKey, value);
    return value;
  }

  sitemapIndex(): { body: string; contentType: string } {
    const cacheKey = 'sitemap.xml';
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const base = this.publicBase.replace(/\/$/, '');
    const langs = Object.values(Language);
    const urls = langs.map((lang) => `${base}/sitemap-${lang}.xml`);
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((u) => `  <sitemap><loc>${u}</loc></sitemap>`),
      '</sitemapindex>',
      '',
    ].join('\n');

    const value = { body: xml, contentType: 'application/xml; charset=utf-8' };
    this.setCache(cacheKey, value);
    return value;
  }

  async perLanguage(lang: Language): Promise<{ body: string; contentType: string }> {
    const cacheKey = `sitemap-${lang}.xml`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const base = this.publicBase.replace(/\/$/, '');

    // Pages (published) for this lang
    const pages = await this.prisma.page.findMany({
      where: { status: 'published', language: lang },
      select: { slug: true },
    });

    // Books (published versions for this lang) — list unique book slugs
    const versions = await this.prisma.bookVersion.findMany({
      where: { status: PublicationStatus.published, language: lang },
      select: { book: { select: { slug: true } } },
    });
    const bookSlugs = Array.from(new Set(versions.map((v) => v.book.slug)));

    const urls: string[] = [];
    // Pages URLs
    for (const p of pages) {
      urls.push(`${base}/${lang}/pages/${p.slug}`);
    }
    // Books canonical URLs include lang prefix
    for (const slug of bookSlugs) {
      urls.push(`${base}/${lang}/books/${slug}`);
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urls.map((u) => `  <url><loc>${u}</loc></url>`),
      '</urlset>',
      '',
    ].join('\n');

    const value = { body: xml, contentType: 'application/xml; charset=utf-8' };
    this.setCache(cacheKey, value);
    return value;
  }
}
