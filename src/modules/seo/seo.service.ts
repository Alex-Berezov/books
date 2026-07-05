import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Language, Seo } from '@prisma/client';
import { UpdateSeoDto } from './dto/update-seo.dto';
import { ResolveSeoQueryDto, ResolveSeoType } from './dto/resolve-seo.dto';
import { getDefaultLanguage, resolveRequestedLanguage } from '../../shared/language/language.util';

// Modular SEO helpers
import { detectIndexability } from './utils/detectIndexability';
import { cleanDescription } from './utils/cleanDescription';
import { buildAbsoluteUrl } from './utils/buildAbsoluteUrl';
import { getCanonicalUrl } from './canonical/getCanonicalUrl';
import { generateHreflangLinks } from './hreflang/generateHreflangLinks';
import { generateBookMeta } from './metadata/generateBookMeta';
import { generateGenreMeta } from './metadata/generateGenreMeta';
import { generateStaticPageMeta } from './metadata/generateStaticPageMeta';
import { generateCatalogMeta } from './metadata/generateCatalogMeta';
import { generateBookSchema } from './schema/generateBookSchema';
import { generateBreadcrumbSchema } from './schema/generateBreadcrumbSchema';
import { generateWebSiteSchema } from './schema/generateWebSiteSchema';
import { generateCollectionPageSchema } from './schema/generateCollectionPageSchema';

interface CategoryWithParent {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

interface BookCategoryLink {
  category: CategoryWithParent;
}

@Injectable()
export class SeoService {
  private cache = new Map<string, { value: Seo | null; expires: number }>();
  private ttlMs: number;

  constructor(private prisma: PrismaService) {
    const raw = process.env.SEO_CACHE_TTL_MS;
    const parsed = raw ? Number(raw) : NaN;
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000; // 5 minutes by default
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

  // Backwards compatible fallback resolver
  async resolve(query: ResolveSeoQueryDto): Promise<unknown> {
    return this.resolvePublic(query.type, query.id, { slug: query.slug });
  }

  // Multilingual home breadcrumb helper
  private getHomeName(lang: Language): string {
    switch (lang) {
      case Language.ru:
        return 'Главная';
      case Language.es:
        return 'Inicio';
      case Language.pt:
        return 'Início';
      case Language.fr:
        return 'Accueil';
      case Language.en:
      default:
        return 'Home';
    }
  }

  /**
   * Public resolver with language awareness.
   */
  async resolvePublic(
    type:
      | ResolveSeoType
      | 'book'
      | 'version'
      | 'page'
      | 'category'
      | 'genre'
      | 'tag'
      | 'catalog'
      | 'collection',
    id: string,
    opts?: { pathLang?: Language; queryLang?: string; acceptLanguage?: string; slug?: string },
  ): Promise<Record<string, unknown>> {
    const pickEffectiveLanguage = (available?: Language[]): Language => {
      const availableArr = available && available.length > 0 ? available : undefined;
      if (availableArr && opts?.pathLang && availableArr.includes(opts.pathLang)) {
        return opts.pathLang;
      }
      const resolved = resolveRequestedLanguage({
        queryLang: opts?.queryLang,
        acceptLanguage: opts?.acceptLanguage,
        available: availableArr,
      });
      return resolved ?? getDefaultLanguage();
    };

    const t = String(type) as
      | 'book'
      | 'version'
      | 'page'
      | 'category'
      | 'genre'
      | 'tag'
      | 'catalog'
      | 'collection';

    if (t === 'version') {
      const v = await this.prisma.bookVersion.findUnique({
        where: { id },
      });
      if (!v) throw new NotFoundException('BookVersion not found');

      const baseMeta = generateBookMeta({
        title: v.title,
        author: v.author,
        description: v.description,
        language: v.language,
      });

      const seo = v.seoId ? await this.prisma.seo.findUnique({ where: { id: v.seoId } }) : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('version', v.id);
      const robotsStatus = detectIndexability(v.status, canonicalUrl, seo?.robots);

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || v.coverImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(v.language), url: getCanonicalUrl('static', '', v.language) },
        { name: v.title, url: canonicalUrl },
      ];
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
      const bookSchema = generateBookSchema({
        slug: v.slug || v.id,
        title: v.title,
        authorName: v.author,
        language: v.language,
        genres: [],
        coverImageUrl: v.coverImageUrl,
        description: metaDescription,
        textAvailable: v.type === 'text',
        audioAvailable: v.type === 'audio',
      });

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'book',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: metaTitle,
              description: metaDescription,
              inLanguage: v.language.toLowerCase(),
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            breadcrumbSchema,
            bookSchema,
          ],
        },
      };
    }

    if (t === 'book') {
      // Find version by slug or book by slug
      const targetVersion = await this.prisma.bookVersion.findFirst({
        where: { slug: id, status: 'published' },
      });

      let bookId: string | null = null;
      if (targetVersion) {
        bookId = targetVersion.bookId;
      } else {
        const legacyBook = await this.prisma.book.findUnique({
          where: { slug: id },
        });
        if (legacyBook) {
          bookId = legacyBook.id;
        }
      }

      if (!bookId) {
        throw new NotFoundException(`Book not found for slug or id "${id}"`);
      }

      const versions = await this.prisma.bookVersion.findMany({
        where: { bookId, status: 'published' },
      });

      const available = versions.map((v) => v.language);
      const effLang = pickEffectiveLanguage(available);
      const chosen = versions.find((v) => v.language === effLang) ?? versions[0];

      if (!chosen) {
        // Fallback if book has no published versions
        const canonicalUrl = getCanonicalUrl('book', id, effLang);
        return {
          meta: {
            title: `Book ${id}`,
            description: undefined,
            robots: 'noindex, follow',
            canonicalUrl,
          },
          openGraph: {
            title: `Book ${id}`,
            description: undefined,
            type: 'book',
            url: canonicalUrl,
          },
          twitter: {
            card: 'summary',
          },
          schema: {
            '@context': 'https://schema.org',
            '@graph': [generateWebSiteSchema(effLang)],
          },
        };
      }

      const cleanedDesc = await cleanDescription(
        this.prisma,
        chosen.id,
        chosen.title,
        chosen.author,
        effLang,
        chosen.description,
      );

      const baseMeta = generateBookMeta({
        title: chosen.title,
        author: chosen.author,
        description: cleanedDesc,
        language: effLang,
      });

      const seo = chosen.seoId
        ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
        : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('book', chosen.slug || id, effLang);
      const robotsStatus = detectIndexability(chosen.status, canonicalUrl, seo?.robots);

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || chosen.coverImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      // Hreflang alternate links
      const slugsMap: Record<string, string> = {};
      for (const v of versions) {
        if (v.slug) {
          slugsMap[v.language.toLowerCase()] = v.slug;
        }
      }
      const hreflangLinks = generateHreflangLinks('book', slugsMap);

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
      ];

      // Add Category breadcrumbs
      try {
        let cat: CategoryWithParent | null = null;
        if (chosen.primaryCategoryId) {
          cat = await this.prisma.category.findUnique({
            where: { id: chosen.primaryCategoryId },
            select: { id: true, name: true, slug: true, parentId: true },
          });
        }
        if (!cat) {
          const rawLinks = await this.prisma.bookCategory.findMany({
            where: { bookVersionId: chosen.id },
            select: { category: { select: { id: true, name: true, slug: true, parentId: true } } },
          });
          const links = rawLinks as unknown as BookCategoryLink[];
          cat = links[0]?.category ?? null;
        }
        if (cat) {
          const catPath: Array<{ name: string; slug: string }> = [];
          let current: CategoryWithParent | null = cat;
          while (current) {
            const trans = await this.prisma.categoryTranslation.findUnique({
              where: { categoryId_language: { categoryId: current.id, language: effLang } },
            });
            catPath.push({
              name: trans?.name || current.name,
              slug: trans?.slug || current.slug,
            });
            if (current.parentId) {
              const parent = await this.prisma.category.findUnique({
                where: { id: current.parentId },
                select: { id: true, name: true, slug: true, parentId: true },
              });
              current = parent as CategoryWithParent | null;
            } else {
              current = null;
            }
          }
          catPath.reverse().forEach((p) => {
            breadcrumbItems.push({
              name: p.name,
              url: getCanonicalUrl('category', p.slug, effLang),
            });
          });
        }
      } catch {
        // Ignore breadcrumb categories errors
      }

      breadcrumbItems.push({ name: chosen.title, url: canonicalUrl });
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);

      // Add genres
      const genresList: string[] = [];
      try {
        const bookCategories = await this.prisma.bookCategory.findMany({
          where: { bookVersionId: chosen.id },
          include: { category: { include: { translations: true } } },
        });
        for (const bc of bookCategories) {
          const trans =
            bc.category.translations.find((t) => t.language === effLang) ||
            bc.category.translations[0];
          if (trans) genresList.push(trans.name);
        }
      } catch {
        // ignore errors
      }

      // Ratings
      let ratingAverage: number | null = null;
      let ratingCount = 0;
      try {
        const ratings = await this.prisma.bookRating.findMany({
          where: { bookId: chosen.bookId },
          select: { score: true },
        });
        ratingCount = ratings.length;
        if (ratingCount > 0) {
          const sum = ratings.reduce((acc, r) => acc + r.score, 0);
          ratingAverage = parseFloat((sum / ratingCount).toFixed(2));
        }
      } catch {
        // ignore rating errors
      }

      // Retrieve published comments for schema.org review
      let bookComments: Array<{
        text: string;
        createdAt: Date;
        user: { name: string | null } | null;
      }> = [];
      try {
        bookComments = await this.prisma.comment.findMany({
          where: { bookVersionId: chosen.id, isDeleted: false, isHidden: false, parentId: null },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { name: true } } },
        });
      } catch {
        // ignore comment errors
      }

      const bookSchema = generateBookSchema({
        slug: chosen.slug || id,
        title: chosen.title,
        authorName: chosen.author,
        authorSlug: encodeURIComponent(
          (chosen.author || '').trim().toLowerCase().replace(/\s+/g, '-'),
        ),
        language: effLang,
        genres: genresList,
        coverImageUrl: chosen.coverImageUrl,
        description: metaDescription,
        textAvailable: chosen.type === 'text',
        audioAvailable: chosen.type === 'audio',
        ratingAverage,
        ratingCount,
        reviews: bookComments.map((c) => ({
          authorName: c.user?.name || 'Anonymous',
          reviewBody: c.text,
          datePublished: c.createdAt.toISOString(),
        })),
      });

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'book',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: metaTitle,
              description: metaDescription,
              inLanguage: effLang.toLowerCase(),
              isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            generateWebSiteSchema(effLang),
            breadcrumbSchema,
            bookSchema,
          ],
        },
        hreflangs: hreflangLinks,
        // Compatibility field for legacy tests
        breadcrumbPath: breadcrumbItems.slice(1, -1).map((item) => ({
          name: item.name,
          slug: item.url.split('/').pop() || '',
        })),
      };
    }

    if (t === 'page') {
      const candidates = await this.prisma.page.findMany({
        where: { slug: id, status: 'published' },
      });
      if (candidates.length === 0) throw new NotFoundException('Page not found');

      const available = candidates.map((c) => c.language);
      const effLang = pickEffectiveLanguage(available);
      const chosen = candidates.find((c) => c.language === effLang) ?? candidates[0];

      const page = await this.prisma.page.findUnique({
        where: { id: chosen.id },
      });
      if (!page) throw new NotFoundException('Page not found');

      const baseMeta = generateStaticPageMeta({
        title: page.title,
        content: page.content,
        language: effLang,
      });

      const seo = page.seoId
        ? await this.prisma.seo.findUnique({ where: { id: page.seoId } })
        : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('page', page.slug, effLang);
      const robotsStatus = detectIndexability(page.status, canonicalUrl, seo?.robots);

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      // Hreflangs
      const slugsMap: Record<string, string> = {};
      const pagesInGroup = page.translationGroupId
        ? await this.prisma.page.findMany({
            where: { translationGroupId: page.translationGroupId, status: 'published' },
          })
        : candidates;

      for (const p of pagesInGroup) {
        slugsMap[p.language.toLowerCase()] = p.slug;
      }
      const hreflangLinks = generateHreflangLinks('page', slugsMap);

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
        { name: page.title, url: canonicalUrl },
      ];
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);

      // Event Schema (optional support for old tests)
      const eventSchema = seo?.eventName
        ? {
            '@type': 'Event',
            name: seo.eventName,
            description: seo.eventDescription || undefined,
            startDate: seo.eventStartDate?.toISOString(),
            endDate: seo.eventEndDate?.toISOString(),
            url: seo.eventUrl || undefined,
            image: seo.eventImageUrl || undefined,
            location: seo.eventLocationName
              ? {
                  '@type': 'Place',
                  name: seo.eventLocationName,
                  address: {
                    '@type': 'PostalAddress',
                    streetAddress: seo.eventLocationStreet || undefined,
                    addressLocality: seo.eventLocationCity || undefined,
                    addressRegion: seo.eventLocationRegion || undefined,
                    postalCode: seo.eventLocationPostal || undefined,
                    addressCountry: seo.eventLocationCountry || undefined,
                  },
                }
              : undefined,
          }
        : undefined;

      const graph: Record<string, unknown>[] = [
        {
          '@type': 'WebPage',
          '@id': `${canonicalUrl}#webpage`,
          url: canonicalUrl,
          name: metaTitle,
          description: metaDescription,
          inLanguage: effLang.toLowerCase(),
          isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
          breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
        },
        generateWebSiteSchema(effLang),
        breadcrumbSchema,
      ];
      if (eventSchema) {
        graph.push(eventSchema);
      }

      const result: {
        meta: Record<string, unknown>;
        openGraph: Record<string, unknown>;
        twitter: Record<string, unknown>;
        schema: { '@context': string; '@graph': Record<string, unknown>[]; event?: unknown };
        hreflangs: unknown[];
      } = {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'website',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': graph,
        },
        hreflangs: hreflangLinks,
      };

      // Compatibility for legacy tests checking schema.event directly
      if (seo?.eventName) {
        result.schema.event = {
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
        };
      }

      return result;
    }

    if (t === 'category') {
      const effLang = opts?.pathLang ?? pickEffectiveLanguage();
      const slugVal = opts?.slug || id;

      const transCandidates = await this.prisma.categoryTranslation.findMany({
        where: {
          OR: [{ slug: slugVal }, { categoryId: id }],
          category: { type: 'category' },
        },
        include: { category: true },
      });

      if (transCandidates.length === 0) {
        throw new NotFoundException('Category translation not found');
      }

      const chosen = transCandidates.find((t) => t.language === effLang) ?? transCandidates[0];

      const baseMeta = generateGenreMeta({
        name: chosen.name,
        description: chosen.description,
        language: effLang,
      });

      const seo = chosen.seoId
        ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
        : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('category', chosen.slug, effLang);
      const robotsStatus = detectIndexability(
        'published',
        canonicalUrl,
        seo?.robots,
        chosen.category.indexable,
      );

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      // Hreflangs
      const slugsMap: Record<string, string> = {};
      for (const t of transCandidates) {
        slugsMap[t.language.toLowerCase()] = t.slug;
      }
      const hreflangLinks = generateHreflangLinks('category', slugsMap);

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
      ];

      // Add parent categories
      try {
        let currentParentId = chosen.category?.parentId ?? null;
        const catPath: Array<{ name: string; slug: string }> = [];
        while (currentParentId) {
          const parentTrans = await this.prisma.categoryTranslation.findUnique({
            where: { categoryId_language: { categoryId: currentParentId, language: effLang } },
          });
          const parentCat = await this.prisma.category.findUnique({
            where: { id: currentParentId },
          });
          if (!parentCat) break;
          catPath.push({
            name: parentTrans?.name || parentCat.name,
            slug: parentTrans?.slug || parentCat.slug,
          });
          currentParentId = parentCat.parentId;
        }
        catPath.reverse().forEach((p) => {
          breadcrumbItems.push({
            name: p.name,
            url: getCanonicalUrl('category', p.slug, effLang),
          });
        });
      } catch {
        // Ignore parent breadcrumbs errors
      }

      breadcrumbItems.push({ name: chosen.name, url: canonicalUrl });
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
      const collectionSchema = generateCollectionPageSchema(
        'category',
        chosen.slug,
        effLang,
        chosen.name,
        metaDescription || '',
        [],
      );

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'website',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: metaTitle,
              description: metaDescription,
              inLanguage: effLang.toLowerCase(),
              isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            generateWebSiteSchema(effLang),
            breadcrumbSchema,
            collectionSchema,
          ],
        },
        hreflangs: hreflangLinks,
        breadcrumbPath: breadcrumbItems.slice(1, -1).map((item) => ({
          name: item.name,
          slug: item.url.split('/').pop() || '',
        })),
      };
    }

    if (t === 'collection') {
      const effLang = opts?.pathLang ?? pickEffectiveLanguage();
      const slugVal = opts?.slug || id;

      const transCandidates = await this.prisma.categoryTranslation.findMany({
        where: {
          OR: [{ slug: slugVal }, { categoryId: id }],
          category: { type: 'collection' },
        },
        include: { category: true },
      });

      if (transCandidates.length === 0) {
        throw new NotFoundException('Collection not found');
      }

      const chosen = transCandidates.find((t) => t.language === effLang) ?? transCandidates[0];

      const baseMeta = generateGenreMeta({
        name: chosen.name,
        description: chosen.description,
        language: effLang,
      });

      const seo = chosen.seoId
        ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
        : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('collection', chosen.slug, effLang);
      const robotsStatus = detectIndexability(
        'published',
        canonicalUrl,
        seo?.robots,
        chosen.category.indexable,
      );

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      // Hreflangs
      const slugsMap: Record<string, string> = {};
      for (const t of transCandidates) {
        slugsMap[t.language.toLowerCase()] = t.slug;
      }
      const hreflangLinks = generateHreflangLinks('collection', slugsMap);

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
        {
          name:
            effLang === 'ru'
              ? 'Подборки'
              : effLang === 'es'
                ? 'Colecciones'
                : effLang === 'pt'
                  ? 'Coleções'
                  : effLang === 'fr'
                    ? 'Collections'
                    : 'Collections',
          url: getCanonicalUrl('static', 'collections', effLang),
        },
      ];

      // Add parent categories
      try {
        let currentParentId = chosen.category?.parentId ?? null;
        const catPath: Array<{ name: string; slug: string }> = [];
        while (currentParentId) {
          const parentTrans = await this.prisma.categoryTranslation.findUnique({
            where: { categoryId_language: { categoryId: currentParentId, language: effLang } },
          });
          const parentCat = await this.prisma.category.findUnique({
            where: { id: currentParentId },
          });
          if (!parentCat) break;
          catPath.push({
            name: parentTrans?.name || parentCat.name,
            slug: parentTrans?.slug || parentCat.slug,
          });
          currentParentId = parentCat.parentId;
        }
        catPath.reverse().forEach((p) => {
          breadcrumbItems.push({
            name: p.name,
            url: getCanonicalUrl('collection', p.slug, effLang),
          });
        });
      } catch {
        // Ignore parent breadcrumbs errors
      }

      breadcrumbItems.push({ name: chosen.name, url: canonicalUrl });
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
      const collectionSchema = generateCollectionPageSchema(
        'collection',
        chosen.slug,
        effLang,
        chosen.name,
        metaDescription || '',
        [],
      );

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'website',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: metaTitle,
              description: metaDescription,
              inLanguage: effLang.toLowerCase(),
              isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            generateWebSiteSchema(effLang),
            breadcrumbSchema,
            collectionSchema,
          ],
        },
        hreflangs: hreflangLinks,
        breadcrumbPath: breadcrumbItems.slice(1, -1).map((item) => ({
          name: item.name,
          slug: item.url.split('/').pop() || '',
        })),
      };
    }

    if (t === 'genre') {
      const effLang = opts?.pathLang ?? pickEffectiveLanguage();
      const slugVal = opts?.slug || id;

      const transCandidates = await this.prisma.categoryTranslation.findMany({
        where: {
          OR: [{ slug: slugVal }, { categoryId: id }],
          category: { type: 'genre' },
        },
        include: { category: true },
      });

      if (transCandidates.length === 0) {
        throw new NotFoundException('Genre translation not found');
      }

      const chosen = transCandidates.find((t) => t.language === effLang) ?? transCandidates[0];

      const baseMeta = generateGenreMeta({
        name: chosen.name,
        description: chosen.description,
        language: effLang,
      });

      const seo = chosen.seoId
        ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
        : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('genre', chosen.slug, effLang);
      const robotsStatus = detectIndexability(
        'published',
        canonicalUrl,
        seo?.robots,
        chosen.category.indexable,
      );

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      const slugsMap: Record<string, string> = {};
      for (const t of transCandidates) {
        slugsMap[t.language.toLowerCase()] = t.slug;
      }
      const hreflangLinks = generateHreflangLinks('genre', slugsMap);

      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
      ];

      try {
        let currentParentId = chosen.category?.parentId ?? null;
        const catPath: Array<{ name: string; slug: string }> = [];
        while (currentParentId) {
          const parentTrans = await this.prisma.categoryTranslation.findUnique({
            where: { categoryId_language: { categoryId: currentParentId, language: effLang } },
          });
          const parentCat = await this.prisma.category.findUnique({
            where: { id: currentParentId },
          });
          if (!parentCat) break;
          catPath.push({
            name: parentTrans?.name || parentCat.name,
            slug: parentTrans?.slug || parentCat.slug,
          });
          currentParentId = parentCat.parentId;
        }
        catPath.reverse().forEach((p) => {
          breadcrumbItems.push({
            name: p.name,
            url: getCanonicalUrl('genre', p.slug, effLang),
          });
        });
      } catch {
        // Ignore parent breadcrumbs errors
      }

      breadcrumbItems.push({ name: chosen.name, url: canonicalUrl });
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
      const collectionSchema = generateCollectionPageSchema(
        'genre',
        chosen.slug,
        effLang,
        chosen.name,
        metaDescription || '',
        [],
      );

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'website',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: metaTitle,
              description: metaDescription,
              inLanguage: effLang.toLowerCase(),
              isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            generateWebSiteSchema(effLang),
            breadcrumbSchema,
            collectionSchema,
          ],
        },
        hreflangs: hreflangLinks,
        breadcrumbPath: breadcrumbItems.slice(1, -1).map((item) => ({
          name: item.name,
          slug: item.url.split('/').pop() || '',
        })),
      };
    }

    if (t === 'tag') {
      const effLang = opts?.pathLang ?? pickEffectiveLanguage();
      const slugVal = opts?.slug || id;

      const transCandidates = await this.prisma.tagTranslation.findMany({
        where: {
          OR: [{ slug: slugVal }, { tagId: id }],
        },
        include: { tag: true },
      });

      if (transCandidates.length === 0) {
        throw new NotFoundException('Tag translation not found');
      }

      const chosen = transCandidates.find((t) => t.language === effLang) ?? transCandidates[0];

      const baseMeta = generateGenreMeta({
        name: chosen.name,
        description: chosen.description,
        language: effLang,
      });

      const seo = chosen.seoId
        ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
        : null;
      const metaTitle = seo?.metaTitle || baseMeta.title;
      const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
      const canonicalUrl = getCanonicalUrl('tag', chosen.slug, effLang);
      const effectiveIndexable = chosen.tag?.indexable !== false && chosen.indexable !== false;
      const robotsStatus = detectIndexability(
        'published',
        canonicalUrl,
        seo?.robots,
        effectiveIndexable,
      );

      const ogTitle = seo?.ogTitle || metaTitle;
      const ogDescription = seo?.ogDescription || metaDescription;
      const ogUrl = seo?.ogUrl || canonicalUrl;
      const ogImageUrl = seo?.ogImageUrl || undefined;
      const ogImageAlt = seo?.ogImageAlt || metaTitle;
      const twitterCard = seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary');

      // Hreflangs
      const slugsMap: Record<string, string> = {};
      for (const t of transCandidates) {
        slugsMap[t.language.toLowerCase()] = t.slug;
      }
      const hreflangLinks = generateHreflangLinks('tag', slugsMap);

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
        { name: chosen.name, url: canonicalUrl },
      ];
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
      const collectionSchema = generateCollectionPageSchema(
        'tag',
        chosen.slug,
        effLang,
        chosen.name,
        metaDescription || '',
        [],
      );

      return {
        meta: {
          title: metaTitle,
          description: metaDescription,
          robots: robotsStatus,
          canonicalUrl,
        },
        openGraph: {
          title: ogTitle,
          description: ogDescription,
          type: 'website',
          url: ogUrl,
          image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
        },
        twitter: {
          card: twitterCard,
          site: seo?.twitterSite || undefined,
          creator: seo?.twitterCreator || undefined,
          image: ogImageUrl || undefined,
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'WebPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: metaTitle,
              description: metaDescription,
              inLanguage: effLang.toLowerCase(),
              isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            generateWebSiteSchema(effLang),
            breadcrumbSchema,
            collectionSchema,
          ],
        },
        hreflangs: hreflangLinks,
      };
    }

    if (t === 'catalog') {
      const effLang = opts?.pathLang ?? pickEffectiveLanguage();
      const baseMeta = generateCatalogMeta({ language: effLang });

      const canonicalUrl = getCanonicalUrl('static', 'catalog', effLang);

      // Hreflangs
      const slugsMap = {
        en: 'catalog',
        es: 'catalog',
        pt: 'catalog',
        fr: 'catalog',
        ru: 'catalog',
      };
      const hreflangLinks = generateHreflangLinks('static', slugsMap);

      // Breadcrumbs
      const breadcrumbItems = [
        { name: this.getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
        {
          name:
            effLang === 'ru'
              ? 'Каталог'
              : effLang === 'es'
                ? 'Catálogo'
                : effLang === 'pt'
                  ? 'Catálogo'
                  : effLang === 'fr'
                    ? 'Catalogue'
                    : 'Catalog',
          url: canonicalUrl,
        },
      ];
      const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);

      return {
        meta: {
          title: baseMeta.title,
          description: baseMeta.description,
          robots: 'index, follow',
          canonicalUrl,
        },
        openGraph: {
          title: baseMeta.title,
          description: baseMeta.description,
          type: 'website',
          url: canonicalUrl,
        },
        twitter: {
          card: 'summary',
        },
        schema: {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'CollectionPage',
              '@id': `${canonicalUrl}#webpage`,
              url: canonicalUrl,
              name: baseMeta.title,
              description: baseMeta.description,
              inLanguage: effLang.toLowerCase(),
              isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
              breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
            },
            generateWebSiteSchema(effLang),
            breadcrumbSchema,
          ],
        },
        hreflangs: hreflangLinks,
      };
    }

    throw new NotFoundException('Unsupported type');
  }
}
