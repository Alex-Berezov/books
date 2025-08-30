import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Seo } from '@prisma/client';
import { UpdateSeoDto } from './dto/update-seo.dto';
import { ResolveSeoQueryDto, ResolveSeoType } from './dto/resolve-seo.dto';
import { Language } from '@prisma/client';
import { getDefaultLanguage, resolveRequestedLanguage } from '../../shared/language/language.util';

@Injectable()
export class SeoService {
  private cache = new Map<string, { value: Seo | null; expires: number }>();
  private ttlMs: number;

  constructor(private prisma: PrismaService) {
    const raw = process.env.SEO_CACHE_TTL_MS;
    const parsed = raw ? Number(raw) : NaN;
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000; // 5 минут по умолчанию
  }

  private getCache(key: string): Seo | null | undefined {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (hit) this.cache.delete(key);
    return undefined;
  }

  private setCache(key: string, value: Seo | null) {
    this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  private invalidate(key: string) {
    this.cache.delete(key);
  }

  async getByVersion(bookVersionId: string) {
    const cacheKey = `seo:${bookVersionId}`;
    const cached = this.getCache(cacheKey);
    if (cached !== undefined) return cached;

    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!version.seoId) return null;
    const data = await this.prisma.seo.findUnique({ where: { id: version.seoId } });
    this.setCache(cacheKey, data);
    return data;
  }

  async upsertForVersion(bookVersionId: string, dto: UpdateSeoDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    if (!version.seoId) {
      const created = await this.prisma.seo.create({ data: { ...this.dtoToData(dto) } });
      await this.prisma.bookVersion.update({
        where: { id: bookVersionId },
        data: { seoId: created.id },
      });
      this.setCache(`seo:${bookVersionId}`, created);
      return created;
    }

    const updated = await this.prisma.seo.update({
      where: { id: version.seoId },
      data: this.dtoToData(dto),
    });
    this.setCache(`seo:${bookVersionId}`, updated);
    return updated;
  }

  private dtoToData(dto: UpdateSeoDto) {
    const {
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots,
      ogTitle,
      ogDescription,
      ogType,
      ogUrl,
      ogImageUrl,
      ogImageAlt,
      twitterCard,
      twitterSite,
      twitterCreator,
      eventName,
      eventDescription,
      eventStartDate,
      eventEndDate,
      eventUrl,
      eventImageUrl,
      eventLocationName,
      eventLocationStreet,
      eventLocationCity,
      eventLocationRegion,
      eventLocationPostal,
      eventLocationCountry,
    } = dto;
    return {
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots,
      ogTitle,
      ogDescription,
      ogType,
      ogUrl,
      ogImageUrl,
      ogImageAlt,
      twitterCard,
      twitterSite,
      twitterCreator,
      eventName,
      eventDescription,
      eventStartDate: eventStartDate ? new Date(eventStartDate) : undefined,
      eventEndDate: eventEndDate ? new Date(eventEndDate) : undefined,
      eventUrl,
      eventImageUrl,
      eventLocationName,
      eventLocationStreet,
      eventLocationCity,
      eventLocationRegion,
      eventLocationPostal,
      eventLocationCountry,
    };
  }

  // === Resolve SEO bundle ===
  async resolveByParams(type: ResolveSeoType | 'book' | 'version' | 'page', id: string) {
    const publicBase = process.env.LOCAL_PUBLIC_BASE_URL || 'http://localhost:3000';
    const t = String(type) as 'book' | 'version' | 'page';

    const buildBundle = (
      base: {
        title: string;
        description?: string | null;
        canonicalPath: string;
        imageUrl?: string | null;
      },
      seo?: Seo | null,
      opts?: { allowCanonicalOverride?: boolean },
    ) => {
      const allowOverride = opts?.allowCanonicalOverride ?? true;
      const canonicalUrl = allowOverride
        ? seo?.canonicalUrl || `${publicBase}${base.canonicalPath}`
        : `${publicBase}${base.canonicalPath}`;
      const metaTitle = seo?.metaTitle || base.title;
      const metaDescription = seo?.metaDescription || base.description || undefined;
      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || base.imageUrl || undefined;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: seo?.robots || undefined,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: seo?.ogType || 'website',
          url: ogUrl,
          image: ogImageUrl
            ? { url: ogImageUrl, alt: seo?.ogImageAlt || metaTitle || undefined }
            : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          event: seo?.eventName
            ? {
                name: seo.eventName,
                description: seo.eventDescription || undefined,
                startDate: seo.eventStartDate?.toISOString(),
                endDate: seo.eventEndDate?.toISOString(),
                url: seo.eventUrl || undefined,
                image: seo.eventImageUrl || undefined,
                location: seo.eventLocationName
                  ? {
                      name: seo.eventLocationName,
                      street: seo.eventLocationStreet || undefined,
                      city: seo.eventLocationCity || undefined,
                      region: seo.eventLocationRegion || undefined,
                      postal: seo.eventLocationPostal || undefined,
                      country: seo.eventLocationCountry || undefined,
                    }
                  : undefined,
              }
            : undefined,
        },
      } as const;
    };
    if (t === 'version') {
      const v = await this.prisma.bookVersion.findUnique({ where: { id } });
      if (!v) throw new NotFoundException('BookVersion not found');
      const seo = v.seoId ? await this.prisma.seo.findUnique({ where: { id: v.seoId } }) : null;
      const base = {
        title: `${v.title} — ${v.author}`,
        description: v.description,
        canonicalPath: `/versions/${v.id}`,
        imageUrl: v.coverImageUrl || undefined,
      } as const;
      // For version, canonical must always be the version route
      return buildBundle(base, seo, { allowCanonicalOverride: false });
    }
    if (t === 'book') {
      // Book identified by slug
      const book = await this.prisma.book.findUnique({ where: { slug: id } });
      if (!book) throw new NotFoundException('Book not found');
      // Try find any version with SEO to reuse
      const version = await this.prisma.bookVersion.findFirst({
        where: { bookId: book.id, status: 'published' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          author: true,
          description: true,
          coverImageUrl: true,
          seoId: true,
        },
      });
      const seo = version?.seoId
        ? await this.prisma.seo.findUnique({ where: { id: version.seoId } })
        : null;
      const base = {
        title: version ? `${version.title} — ${version.author}` : `Book ${book.slug}`,
        description: version?.description || null,
        canonicalPath: `/books/${book.slug}`,
        imageUrl: version?.coverImageUrl || undefined,
      } as const;
      return buildBundle(base, seo || undefined);
    }
    if (t === 'page') {
      // Page identified by slug
      const page = await this.prisma.page.findFirst({
        where: { slug: id, status: 'published' },
      });
      if (!page) throw new NotFoundException('Page not found');
      const seo = page.seoId
        ? await this.prisma.seo.findUnique({ where: { id: page.seoId } })
        : null;
      const base = {
        title: page.title,
        description: null,
        canonicalPath: `/pages/${page.slug}`,
        imageUrl: undefined,
      } as const;
      return buildBundle(base, seo || undefined);
    }

    throw new NotFoundException('Unsupported type');
  }

  async resolve(query: ResolveSeoQueryDto) {
    return this.resolveByParams(query.type, query.id);
  }

  /**
   * Public resolver with language awareness. Priority:
   * 1) Path language (if provided and available for the entity)
   * 2) query ?lang
   * 3) Accept-Language
   * 4) DEFAULT_LANGUAGE
   *
   * For type="version" canonical remains non-prefixed (/versions/:id).
   * For type="book" and type="page" canonical is prefixed with effective language.
   */
  async resolvePublic(
    type: ResolveSeoType | 'book' | 'version' | 'page',
    id: string,
    opts?: { pathLang?: Language; queryLang?: string; acceptLanguage?: string },
  ): Promise<any> {
    const publicBase = process.env.LOCAL_PUBLIC_BASE_URL || 'http://localhost:3000';

    const buildBundle = (
      base: {
        title: string;
        description?: string | null;
        canonicalPath: string;
        imageUrl?: string | null;
      },
      seo?: Seo | null,
      opts2?: { allowCanonicalOverride?: boolean },
    ) => {
      const allowOverride = opts2?.allowCanonicalOverride ?? true;
      const canonicalUrl = allowOverride
        ? seo?.canonicalUrl || `${publicBase}${base.canonicalPath}`
        : `${publicBase}${base.canonicalPath}`;
      const metaTitle = seo?.metaTitle || base.title;
      const metaDescription = seo?.metaDescription || base.description || undefined;
      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || base.imageUrl || undefined;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: seo?.robots || undefined,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: seo?.ogType || 'website',
          url: ogUrl,
          image: ogImageUrl
            ? { url: ogImageUrl, alt: seo?.ogImageAlt || metaTitle || undefined }
            : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          event: seo?.eventName
            ? {
                name: seo.eventName,
                description: seo.eventDescription || undefined,
                startDate: seo.eventStartDate?.toISOString(),
                endDate: seo.eventEndDate?.toISOString(),
                url: seo.eventUrl || undefined,
                image: seo.eventImageUrl || undefined,
                location: seo.eventLocationName
                  ? {
                      name: seo.eventLocationName,
                      street: seo.eventLocationStreet || undefined,
                      city: seo.eventLocationCity || undefined,
                      region: seo.eventLocationRegion || undefined,
                      postal: seo.eventLocationPostal || undefined,
                      country: seo.eventLocationCountry || undefined,
                    }
                  : undefined,
              }
            : undefined,
        },
      } as const;
    };

    const pickEffectiveLanguage = (available?: Language[]): Language => {
      const availableArr = available && available.length > 0 ? available : undefined;
      if (availableArr && opts?.pathLang && availableArr.includes(opts.pathLang))
        return opts.pathLang;
      const resolved = resolveRequestedLanguage({
        queryLang: opts?.queryLang,
        acceptLanguage: opts?.acceptLanguage,
        available: availableArr,
      });
      return resolved ?? getDefaultLanguage();
    };

    const t = String(type) as 'book' | 'version' | 'page';
    if (t === 'version') {
      const v = await this.prisma.bookVersion.findUnique({ where: { id } });
      if (!v) throw new NotFoundException('BookVersion not found');
      const seo = v.seoId ? await this.prisma.seo.findUnique({ where: { id: v.seoId } }) : null;
      const base = {
        title: `${v.title} — ${v.author}`,
        description: v.description,
        canonicalPath: `/versions/${v.id}`,
        imageUrl: v.coverImageUrl || undefined,
      } as const;
      return buildBundle(base, seo, { allowCanonicalOverride: false });
    }

    if (t === 'book') {
      const book = await this.prisma.book.findUnique({ where: { slug: id } });
      if (!book) throw new NotFoundException('Book not found');
      const versions = await this.prisma.bookVersion.findMany({
        where: { bookId: book.id, status: 'published' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          language: true,
          title: true,
          author: true,
          description: true,
          coverImageUrl: true,
          seoId: true,
        },
      });
      const available = versions.map((v) => v.language);
      const effLang = pickEffectiveLanguage(available);
      const chosen = versions.find((v) => v.language === effLang) ?? versions[0];
      const seo = chosen?.seoId
        ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
        : null;
      const base = {
        title: chosen ? `${chosen.title} — ${chosen.author}` : `Book ${book.slug}`,
        description: chosen?.description || null,
        canonicalPath: `/${effLang}/books/${book.slug}`,
        imageUrl: chosen?.coverImageUrl || undefined,
      } as const;
      return buildBundle(base, seo || undefined);
    }

    if (t === 'page') {
      const candidates = await this.prisma.page.findMany({
        where: { slug: id, status: 'published' },
        select: { id: true, language: true },
      });
      if (candidates.length === 0) throw new NotFoundException('Page not found');
      const available = candidates.map((c) => c.language);
      const effLang = pickEffectiveLanguage(available);
      const pick = candidates.find((c) => c.language === effLang) ?? candidates[0];
      const page = await this.prisma.page.findUnique({ where: { id: pick.id } });
      const seo = page?.seoId
        ? await this.prisma.seo.findUnique({ where: { id: page.seoId } })
        : null;
      const base = {
        title: page!.title,
        description: null,
        canonicalPath: `/${effLang}/pages/${page!.slug}`,
        imageUrl: undefined,
      } as const;
      return buildBundle(base, seo || undefined);
    }

    // Fallback: use original behavior
    return this.resolveByParams(type, id);
  }
}
