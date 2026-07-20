import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { BookCardDto } from './dto/book-card.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { BookType, Language, Category, CategoryTranslation, Prisma } from '@prisma/client';
import { resolveRequestedLanguage } from '../../shared/language/language.util';
import { cleanDescription } from '../seo/utils/cleanDescription';
import { RedirectException } from '../../common/exceptions/redirect.exception';

@Injectable()
export class BookService {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateBookDto) {
    return this.prisma.book.create({ data });
  }

  async rateBook(userId: string, bookId: string, score: number) {
    const book = await this.prisma.book.findUnique({ where: { id: bookId } });
    if (!book) throw new NotFoundException(`Book with ID ${bookId} not found`);

    return this.prisma.bookRating.upsert({
      where: { userId_bookId: { userId, bookId } },
      create: { userId, bookId, score },
      update: { score },
    });
  }

  async getUserRating(userId: string, bookId: string): Promise<{ score: number | null }> {
    const rating = await this.prisma.bookRating.findUnique({
      where: { userId_bookId: { userId, bookId } },
    });
    return { score: rating?.score ?? null };
  }

  private async getAverageRating(bookId: string): Promise<number | null> {
    const agg = await this.prisma.bookRating.aggregate({
      where: { bookId },
      _avg: { score: true },
    });
    return agg._avg.score ?? null;
  }

  async findAll(paginationDto?: PaginationDto) {
    const { page = 1, limit = 10 } = paginationDto || {};
    const skip = (page - 1) * limit;

    const [books, total] = await Promise.all([
      this.prisma.book.findMany({
        include: {
          versions: {
            include: {
              _count: {
                select: {
                  chapters: true,
                  audioChapters: true,
                  summaries: true,
                },
              },
              tags: {
                include: {
                  tag: {
                    include: {
                      translations: true,
                    },
                  },
                },
              },
            },
          },
        },
        skip,
        take: limit,
      }),
      this.prisma.book.count(),
    ]);

    const data = await Promise.all(
      books.map(async (book) => {
        const rating = await this.getAverageRating(book.id);
        const hasText = book.versions.some(
          (v) => v.status === 'published' && (v._count?.chapters > 0 || v.type === 'text'),
        );
        const hasAudio = book.versions.some(
          (v) => v.status === 'published' && v._count?.audioChapters > 0,
        );
        const hasSummary = book.versions.some(
          (v) => v.status === 'published' && v._count?.summaries > 0,
        );

        return {
          ...book,
          rating,
          hasText,
          hasAudio,
          hasSummary,
        };
      }),
    );

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const book = await this.prisma.book.findUnique({
      where: { id },
      include: {
        versions: {
          include: {
            categories: {
              include: { category: true },
            },
            tags: {
              include: { tag: true },
            },
          },
        },
      },
    });

    if (!book) {
      throw new NotFoundException(`Book with ID ${id} not found`);
    }

    const rating = await this.getAverageRating(book.id);

    return {
      ...book,
      rating,
      versions: book.versions.map((v) => ({
        ...v,
        categories: v.categories.map((c) => c.category),
        tags: v.tags.map((t) => t.tag),
      })),
    };
  }

  async findBySlug(slug: string) {
    const version = await this.prisma.bookVersion.findFirst({
      where: { slug },
      select: { bookId: true },
    });

    const bookId = version?.bookId;

    const book = await this.prisma.book.findFirst({
      where: bookId ? { id: bookId } : { slug },
      include: {
        versions: {
          include: {
            categories: {
              include: { category: true },
            },
            tags: {
              include: { tag: true },
            },
          },
        },
      },
    });

    if (!book) {
      throw new NotFoundException(`Book with slug ${slug} not found`);
    }

    const rating = await this.getAverageRating(book.id);

    return {
      ...book,
      rating,
      versions: book.versions.map((v) => ({
        ...v,
        categories: v.categories.map((c) => c.category),
        tags: v.tags.map((t) => t.tag),
      })),
    };
  }

  // Overview aggregation for frontend
  async getOverview(slug: string, lang?: string, acceptLanguageHeader?: string) {
    const prismaLangs = Object.values(Language);
    const isPathLang = lang && prismaLangs.includes(lang as Language);

    // 1. Try to find the version by slug
    const matchedVersion = await this.prisma.bookVersion.findFirst({
      where: { slug, status: 'published' },
      select: { bookId: true, language: true, id: true },
    });

    let bookId: string | null = null;
    if (matchedVersion) {
      bookId = matchedVersion.bookId;
    } else {
      // Fallback to legacy Book.slug search
      const legacyBook = await this.prisma.book.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (legacyBook) {
        bookId = legacyBook.id;
      }
    }

    if (!bookId) {
      throw new NotFoundException(`Book with slug "${slug}" not found`);
    }

    // Load all published versions for this book
    const versions = await this.prisma.bookVersion.findMany({
      where: { bookId, status: 'published' },
      include: {
        _count: {
          select: {
            chapters: true,
            audioChapters: true,
            summaries: true,
          },
        },
      },
    });

    const availableLanguages = Array.from(new Set(versions.map((v) => v.language)));

    const preferredLang = resolveRequestedLanguage({
      queryLang: lang,
      acceptLanguage: acceptLanguageHeader || null,
      available: availableLanguages,
    });

    // Check if we need to redirect due to slug/language mismatch
    // (e.g. requested slug is Portuguese but language context is English, or requested slug is legacy Book.slug)
    const targetVersion = versions.find((v) => v.language === preferredLang) || versions[0];
    if (targetVersion && targetVersion.slug && targetVersion.slug !== slug) {
      // Perform 301 Redirect
      let redirectUrl = '';
      if (isPathLang) {
        redirectUrl = `/api/${preferredLang}/books/${targetVersion.slug}/overview`;
      } else {
        redirectUrl = `/api/books/${targetVersion.slug}/overview?lang=${preferredLang}`;
      }
      throw new RedirectException(redirectUrl);
    }

    // We can read it if it is preferredLang and has chapters OR has type text, or fallback to first version with chapters/text
    const textVersion =
      versions.find(
        (v) => v.language === preferredLang && (v._count.chapters > 0 || v.type === BookType.text),
      ) ||
      versions.find((v) => v._count.chapters > 0 || v.type === BookType.text) ||
      null;

    // We can listen if it is preferredLang and has audioChapters
    const audioVersion =
      versions.find((v) => v.language === preferredLang && v._count.audioChapters > 0) || null;

    // Pick referral version
    const referralVersion =
      versions.find((v) => v.language === preferredLang && v.type === BookType.referral) ||
      versions.find((v) => v.type === BookType.referral) ||
      null;

    // Check features
    const hasText =
      !!textVersion && (textVersion._count.chapters > 0 || textVersion.type === BookType.text);
    const hasAudio = !!audioVersion;

    // Summary exists if BookSummary row exists for the resolved text or audio version
    const hasSummary =
      (!!textVersion && textVersion._count.summaries > 0) ||
      (!!audioVersion && audioVersion._count.summaries > 0);

    const loadSeo = async (versionId: string | null | undefined) => {
      if (!versionId) return null;
      const v = versions.find((vv) => vv.id === versionId);
      if (!v?.seoId) return null;
      return this.prisma.seo.findUnique({
        where: { id: v.seoId },
        select: { metaTitle: true, metaDescription: true },
      });
    };
    const seo = {
      main:
        (await loadSeo(textVersion?.id)) ??
        (await loadSeo(audioVersion?.id)) ??
        (await loadSeo(referralVersion?.id)) ??
        null,
      read: (await loadSeo(textVersion?.id)) ?? null,
      listen: (await loadSeo(audioVersion?.id)) ?? null,
      summary: (await loadSeo(textVersion?.id)) ?? (await loadSeo(audioVersion?.id)) ?? null,
    } as const;

    const activeVersion = (textVersion || audioVersion || referralVersion) as {
      id: string;
      title: string;
      author: string;
      description: string;
      coverImageUrl: string;
      primaryCategoryId: string | null;
      firstPublishedYear: number | null;
      editionPublishedYear: number | null;
      publishedAt: Date | null;
    } | null;

    // Fetch categories and tags for the active version
    const categoriesRelation =
      activeVersion && this.prisma.bookCategory
        ? await this.prisma.bookCategory.findMany({
            where: { bookVersionId: activeVersion.id },
            include: { category: { include: { translations: true } } },
          })
        : [];
    const tagsRelation =
      activeVersion && this.prisma.bookTag
        ? await this.prisma.bookTag.findMany({
            where: { bookVersionId: activeVersion.id },
            include: { tag: { include: { translations: true } } },
          })
        : [];

    const categories = categoriesRelation.map((c) => ({
      ...c.category,
    }));
    const tags = tagsRelation.map((t) => ({
      ...t.tag,
    }));

    const book = await this.prisma.book.findUnique({ where: { id: bookId } });

    let primaryCategory: (Category & { translations: CategoryTranslation[] }) | null = null;
    const primaryCategoryId = activeVersion?.primaryCategoryId;
    if (primaryCategoryId) {
      primaryCategory = await this.prisma.category.findUnique({
        where: { id: primaryCategoryId },
        include: { translations: true },
      });
    }

    const cleanedDesc = activeVersion
      ? await cleanDescription(
          this.prisma,
          activeVersion.id,
          activeVersion.title,
          activeVersion.author,
          preferredLang || 'en',
          activeVersion.description,
        )
      : '';

    return {
      id: bookId,
      slug: targetVersion?.slug || slug,
      title: activeVersion?.title || '',
      author: activeVersion?.author || '',
      description: cleanedDesc,
      coverUrl: activeVersion?.coverImageUrl || '',
      rating: await this.getAverageRating(bookId),
      firstPublishedYear: activeVersion?.firstPublishedYear ?? null,
      editionPublishedYear: activeVersion?.editionPublishedYear ?? null,
      publicationYear: activeVersion?.firstPublishedYear
        ? activeVersion.firstPublishedYear
        : activeVersion?.editionPublishedYear
          ? activeVersion.editionPublishedYear
          : activeVersion?.publishedAt
            ? new Date(activeVersion.publishedAt).getFullYear()
            : null,
      language: preferredLang,
      categories,
      tags,
      primaryCategoryId: primaryCategoryId ?? null,
      primaryCategory,
      versions: versions.map((v) => ({
        ...v,
        coverUrl: v.coverImageUrl, // compatibility alias
      })),
      createdAt: book?.createdAt || new Date(),
      updatedAt: book?.updatedAt || new Date(),
      // Keep legacy structure properties for compatibility
      book: { id: bookId, slug: targetVersion?.slug || slug },
      availableLanguages,
      hasText,
      hasAudio,
      hasSummary,
      versionIds: {
        text: textVersion?.id ?? null,
        audio: audioVersion?.id ?? null,
      },
      seo,
    };
  }

  /**
   * Find related books for a book page: same-author and similar-by-category cards.
   *
   * Returns a compact BookCardDto[] per block (no versions/translations/JSON content).
   * - sameAuthor matched by stable `authorId` (NOT by localized author string); legacy fallback by
   *   normalized author string only when authorId IS NULL.
   * - similar matched by stable `categoryId`.
   * - Rating fetched via a single `groupBy` (no N+1).
   * - Stable sort: sameAuthor by publishedAt DESC, id ASC; similar by matched-categories count DESC,
   *   rating DESC, publishedAt DESC, id ASC; fallback by rating DESC, publishedAt DESC, id ASC.
   * - Dedup: current book excluded; a book cannot appear in both blocks; total <= limit.
   *
   * SQL count is bounded by a constant (does not grow with `limit`); no N+1.
   */
  async findRelated(
    slug: string,
    lang: Language,
    limit = 8,
  ): Promise<{
    sameAuthor: BookCardDto[];
    similar: BookCardDto[];
  }> {
    const effectiveLimit = Math.min(Math.max(limit, 1), 16);
    const sameAuthorTake = Math.ceil(effectiveLimit / 2);

    // 1. Resolve the current book's published version for this language
    const currentVersion = await this.prisma.bookVersion.findFirst({
      where: { slug, language: lang, status: 'published' },
      select: {
        bookId: true,
        author: true,
        authorId: true,
      },
    });

    let currentBookId: string | null = currentVersion?.bookId ?? null;
    let currentAuthor: string | null = currentVersion?.author ?? null;
    let currentAuthorId: string | null = currentVersion?.authorId ?? null;
    let currentCategoryIds: string[] = [];

    if (!currentBookId) {
      // Fallback: find by slug across any language, then check a version for the requested lang
      const anyVersion = await this.prisma.bookVersion.findFirst({
        where: { slug, status: 'published' },
        select: { bookId: true },
      });
      currentBookId = anyVersion?.bookId ?? null;
      if (currentBookId) {
        const langVersion = await this.prisma.bookVersion.findFirst({
          where: { bookId: currentBookId, language: lang, status: 'published' },
          select: { author: true, authorId: true },
        });
        currentAuthor = langVersion?.author ?? null;
        currentAuthorId = langVersion?.authorId ?? null;
      }
    }

    if (!currentBookId) {
      throw new NotFoundException(`Book with slug "${slug}" not found in language "${lang}"`);
    }

    // Gather all category IDs of the current book's version for this language
    if (currentBookId) {
      const currentLangVersion = await this.prisma.bookVersion.findFirst({
        where: { bookId: currentBookId, language: lang, status: 'published' },
        select: { id: true },
      });
      if (currentLangVersion) {
        const cats = await this.prisma.bookCategory.findMany({
          where: { bookVersionId: currentLangVersion.id },
          select: { categoryId: true },
        });
        currentCategoryIds = cats.map((c) => c.categoryId);
      }
    }

    // 2. sameAuthor: by stable authorId (preferred) or author string (legacy fallback)
    const sameAuthorWhere: Prisma.BookVersionWhereInput = {
      bookId: { not: currentBookId },
      language: lang,
      status: 'published',
      ...(currentAuthorId
        ? { authorId: currentAuthorId }
        : currentAuthor
          ? { author: { equals: currentAuthor, mode: 'insensitive' } }
          : {}),
    };

    const sameAuthorVersions = await this.prisma.bookVersion.findMany({
      where: sameAuthorWhere,
      select: this.bookCardSelect(),
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: sameAuthorTake,
    });

    const sameAuthorIds = sameAuthorVersions.map((v) => v.bookId);
    const excludedFromSimilar = new Set<string>([currentBookId, ...sameAuthorIds]);

    // 3. similar: by any shared category ID (stable), excluding sameAuthor + current.
    //    Collect candidates first; rating sort applied after ratings are fetched (below).
    let similarCandidates: { version: (typeof sameAuthorVersions)[number]; matched: number }[] = [];
    if (currentCategoryIds.length > 0) {
      const similarBookVersions = await this.prisma.bookCategory.findMany({
        where: {
          categoryId: { in: currentCategoryIds },
          bookVersion: {
            bookId: { notIn: Array.from(excludedFromSimilar) },
            language: lang,
            status: 'published',
          },
        },
        select: {
          bookVersion: { select: this.bookCardSelect() },
          categoryId: true,
        },
      });

      // Aggregate: count matched categories per bookId
      const byBookId = new Map<
        string,
        { version: (typeof sameAuthorVersions)[number]; matched: number }
      >();
      for (const row of similarBookVersions) {
        const v = row.bookVersion;
        const existing = byBookId.get(v.bookId);
        if (existing) {
          existing.matched += 1;
        } else {
          byBookId.set(v.bookId, { version: v, matched: 1 });
        }
      }
      similarCandidates = Array.from(byBookId.values());
    }

    // 4. fallback candidates: any published books in this language not yet selected
    const similarCandidateBookIds = similarCandidates.map((c) => c.version.bookId);
    const remainingSlots = effectiveLimit - sameAuthorVersions.length - similarCandidates.length;
    let fallbackCandidates: (typeof sameAuthorVersions)[number][] = [];
    if (remainingSlots > 0) {
      const alreadySelected = new Set<string>([
        currentBookId,
        ...sameAuthorIds,
        ...similarCandidateBookIds,
      ]);
      // Fetch a slightly larger pool to allow rating-based sorting, then trim
      fallbackCandidates = await this.prisma.bookVersion.findMany({
        where: {
          bookId: { notIn: Array.from(alreadySelected) },
          language: lang,
          status: 'published',
        },
        select: this.bookCardSelect(),
        // Order by publishedAt as a baseline; final rating-based sort below
        orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        take: remainingSlots,
      });
    }

    // 5. Ratings via a single groupBy (no N+1) — for all selected books (sameAuthor + similar + fallback)
    const candidateBookIds = Array.from(
      new Set<string>([
        ...sameAuthorIds,
        ...similarCandidates.map((c) => c.version.bookId),
        ...fallbackCandidates.map((v) => v.bookId),
      ]),
    );
    const ratingsMap = await this.getRatingsForBooks(candidateBookIds);

    // Sort similar by matched DESC, rating DESC, publishedAt DESC, id ASC (stable)
    const similarSorted = similarCandidates
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          (ratingsMap.get(b.version.bookId)?.avg ?? -1) -
            (ratingsMap.get(a.version.bookId)?.avg ?? -1) ||
          this.comparePublishedAtDesc(b.version.publishedAt, a.version.publishedAt) ||
          a.version.id.localeCompare(b.version.id),
      )
      .slice(0, effectiveLimit - sameAuthorVersions.length)
      .map((x) => x.version);

    // Fill remaining with fallback, sorted by rating DESC, publishedAt DESC, id ASC (stable)
    const remainingAfterSimilar = effectiveLimit - sameAuthorVersions.length - similarSorted.length;
    const fallbackSorted = fallbackCandidates
      .filter((v) => !similarSorted.some((s) => s.bookId === v.bookId))
      .sort(
        (a, b) =>
          (ratingsMap.get(b.bookId)?.avg ?? -1) - (ratingsMap.get(a.bookId)?.avg ?? -1) ||
          this.comparePublishedAtDesc(b.publishedAt, a.publishedAt) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(remainingAfterSimilar, 0));
    const similarVersions = [...similarSorted, ...fallbackSorted];

    // 6. Fetch author slugs (AuthorTranslation.slug) for the requested language
    const authorIds = Array.from(
      new Set<string>(
        [...sameAuthorVersions, ...similarVersions]
          .map((v) => v.authorId)
          .filter((id): id is string => !!id),
      ),
    );
    const authorSlugMap = await this.getAuthorSlugs(authorIds, lang);

    return {
      sameAuthor: sameAuthorVersions.map((v) => this.toBookCardDto(v, ratingsMap, authorSlugMap)),
      similar: similarVersions.map((v) => this.toBookCardDto(v, ratingsMap, authorSlugMap)),
    };
  }

  /**
   * Compact paginated list of published book cards for a language (homepage / catalog).
   *
   * Returns BookCardDto[] (no versions/translations/JSON content). One card per book,
   * using the localized published version for slug/title/author/cover.
   * Rating via a single groupBy (no N+1). Server-side max limit = 48.
   *
   * Supports optional filters:
   * - sort: 'popular' (rating desc, publishedAt desc, id asc) or 'new' (publishedAt desc, id asc)
   * - type: 'audio' (hasAudio === true) or 'text' (hasText === true)
   * - q: search by title/author (case-insensitive contains)
   */
  async findCards(
    lang: Language,
    page = 1,
    limit = 24,
    sort?: string,
    type?: string,
    q?: string,
  ): Promise<{
    items: BookCardDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const effectivePage = Math.max(page, 1);
    const effectiveLimit = Math.min(Math.max(limit, 1), 48);
    const skip = (effectivePage - 1) * effectiveLimit;

    // Build where conditions for filters
    const baseWhere: Prisma.BookVersionWhereInput = {
      language: lang,
      status: 'published',
    };

    const filterConditions: Prisma.BookVersionWhereInput[] = [];

    if (type === 'audio') {
      filterConditions.push({ audioChapters: { some: {} } });
    } else if (type === 'text') {
      filterConditions.push({
        OR: [{ chapters: { some: {} } }, { type: BookType.text }],
      });
    }

    if (q) {
      filterConditions.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { author: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const where: Prisma.BookVersionWhereInput =
      filterConditions.length > 0 ? { ...baseWhere, AND: filterConditions } : baseWhere;

    if (sort === 'popular') {
      // For popular sort: fetch all matching bookIds, get ratings, sort by rating, then paginate
      const allVersions = await this.prisma.bookVersion.findMany({
        where,
        select: { id: true, bookId: true, publishedAt: true },
        distinct: ['bookId'],
      });

      const allBookIds = allVersions.map((v) => v.bookId);
      const total = allBookIds.length;

      if (total === 0) {
        return {
          items: [],
          pagination: { page: effectivePage, limit: effectiveLimit, total: 0, totalPages: 0 },
        };
      }

      const ratingsMap = await this.getRatingsForBooks(allBookIds);

      const sorted = allVersions.sort((a, b) => {
        const ratingA = ratingsMap.get(a.bookId)?.avg ?? -1;
        const ratingB = ratingsMap.get(b.bookId)?.avg ?? -1;
        if (ratingB !== ratingA) return ratingB - ratingA;
        return (
          this.comparePublishedAtDesc(b.publishedAt, a.publishedAt) || a.id.localeCompare(b.id)
        );
      });

      const paginatedBookIds = sorted.slice(skip, skip + effectiveLimit).map((v) => v.bookId);
      return this.buildCardsResponse(paginatedBookIds, lang, effectivePage, effectiveLimit, total);
    }

    // Default/new sort: order by publishedAt desc, id asc
    const orderBy: Prisma.BookVersionOrderByWithRelationInput[] = [
      { publishedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ];

    const versions = await this.prisma.bookVersion.findMany({
      where,
      select: { id: true, bookId: true },
      distinct: ['bookId'],
      skip,
      take: effectiveLimit,
      orderBy,
    });

    const total = (
      await this.prisma.bookVersion.groupBy({
        by: ['bookId'],
        where,
      })
    ).length;

    const bookIds = versions.map((v) => v.bookId);
    return this.buildCardsResponse(bookIds, lang, effectivePage, effectiveLimit, total);
  }

  /**
   * Compact paginated list of published book cards for an author (author page fallback).
   *
   * `authorSlug` is resolved to a stable `authorId` via AuthorTranslation.slug, then
   * filtered by BookVersion.authorId. NOT by localized author display name.
   */
  async findCardsByAuthor(
    authorSlug: string,
    lang: Language,
    page = 1,
    limit = 24,
  ): Promise<{
    items: BookCardDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const effectivePage = Math.max(page, 1);
    const effectiveLimit = Math.min(Math.max(limit, 1), 48);
    const skip = (effectivePage - 1) * effectiveLimit;

    // Resolve authorId from slug (prefer requested lang, fallback en)
    const authorTranslation = await this.prisma.authorTranslation.findFirst({
      where: {
        slug: authorSlug,
        language: { in: [lang, Language.en] },
      },
      select: { authorId: true, language: true },
      orderBy: [{ language: 'asc' }],
    });

    if (!authorTranslation) {
      return {
        items: [],
        pagination: { page: effectivePage, limit: effectiveLimit, total: 0, totalPages: 0 },
      };
    }

    const authorId = authorTranslation.authorId;

    const versions = await this.prisma.bookVersion.findMany({
      where: { authorId, language: lang, status: 'published' },
      select: { id: true, bookId: true },
      distinct: ['bookId'],
      skip,
      take: effectiveLimit,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    });

    const total = (
      await this.prisma.bookVersion.groupBy({
        by: ['bookId'],
        where: { authorId, language: lang, status: 'published' },
      })
    ).length;

    const bookIds = versions.map((v) => v.bookId);
    return this.buildCardsResponse(bookIds, lang, effectivePage, effectiveLimit, total);
  }

  /**
   * Compact paginated list of published book cards for a category (or genre/collection).
   *
   * Resolves the category slug to a stable category ID via CategoryTranslation,
   * then returns BookCardDto[] for books in that category.
   */
  async findCardsByCategory(
    categorySlug: string,
    lang: Language,
    page = 1,
    limit = 24,
  ): Promise<{
    category: Record<string, unknown> | null;
    items: BookCardDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const effectivePage = Math.max(page, 1);
    const effectiveLimit = Math.min(Math.max(limit, 1), 48);
    const skip = (effectivePage - 1) * effectiveLimit;

    // Resolve category slug to a stable category ID (prefer translation, fallback base slug)
    const catTrans = await this.prisma.categoryTranslation.findUnique({
      where: { language_slug: { language: lang, slug: categorySlug } },
    });

    let categoryId: string | null = catTrans?.categoryId ?? null;
    let matchedTranslation: Record<string, unknown> | null = catTrans
      ? { ...catTrans, category: undefined }
      : null;

    if (!categoryId) {
      const baseCat = await this.prisma.category.findFirst({
        where: {
          OR: [
            { slug: categorySlug },
            ...(categorySlug.match(/^[0-9a-f-]{36}$/i) ? [{ id: categorySlug }] : []),
          ],
        },
        select: { id: true },
      });
      if (!baseCat) {
        return {
          category: null,
          items: [],
          pagination: { page: effectivePage, limit: effectiveLimit, total: 0, totalPages: 0 },
        };
      }
      categoryId = baseCat.id;

      const trans = await this.prisma.categoryTranslation.findFirst({
        where: { categoryId, language: lang },
      });
      matchedTranslation = trans ? { ...trans, category: undefined } : null;
    }
    // Fetch full category with translation
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      select: {
        id: true,
        key: true,
        slug: true,
        name: true,
        type: true,
        parentId: true,
        indexable: true,
        isVisible: true,
        sortOrder: true,
      },
    });

    // Find distinct bookIds that have a published version in this language with this category
    const bookIds = await this.getBookIdsByCategory(categoryId, lang, skip, effectiveLimit);
    const total = await this.countBookIdsByCategory(categoryId, lang);

    const cardsResponse = await this.buildCardsResponse(
      bookIds,
      lang,
      effectivePage,
      effectiveLimit,
      total,
    );

    return {
      category: category
        ? {
            id: category.id,
            key: category.key,
            slug: matchedTranslation?.slug ?? category.slug,
            name: matchedTranslation?.name ?? category.name,
            type: category.type,
            parentId: category.parentId,
            indexable: category.indexable,
            isVisible: category.isVisible,
            sortOrder: category.sortOrder,
            booksCount: total,
            language: lang,
            translation: matchedTranslation,
            translations: matchedTranslation ? [matchedTranslation] : [],
          }
        : null,
      items: cardsResponse.items,
      pagination: cardsResponse.pagination,
    };
  }

  /**
   * Compact paginated list of published book cards for a tag.
   *
   * Resolves the tag slug to a stable tag ID via TagTranslation,
   * then returns BookCardDto[] for books with that tag.
   */
  async findCardsByTag(
    tagSlug: string,
    lang: Language,
    page = 1,
    limit = 24,
    includeTag = false,
  ): Promise<{
    tag: Record<string, unknown> | null;
    items: BookCardDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const effectivePage = Math.max(page, 1);
    const effectiveLimit = Math.min(Math.max(limit, 1), 48);
    const skip = (effectivePage - 1) * effectiveLimit;

    // Resolve tag slug to a stable tag ID (prefer translation, fallback base slug)
    const tagTrans = await this.prisma.tagTranslation.findUnique({
      where: { language_slug: { language: lang, slug: tagSlug } },
    });
    let tagId: string | null = tagTrans?.tagId ?? null;
    let matchedTranslation: Record<string, unknown> | null = tagTrans
      ? { ...tagTrans, tag: undefined }
      : null;

    if (!tagId) {
      const baseTag = await this.prisma.tag.findFirst({
        where: { slug: tagSlug, isVisible: true },
        select: { id: true },
      });
      if (!baseTag) {
        return {
          tag: null,
          items: [],
          pagination: { page: effectivePage, limit: effectiveLimit, total: 0, totalPages: 0 },
        };
      }
      tagId = baseTag.id;

      const trans = await this.prisma.tagTranslation.findFirst({
        where: { tagId, language: lang },
      });
      matchedTranslation = trans ? { ...trans, tag: undefined } : null;
    }

    // Find distinct bookIds that have a published version in this language with this tag
    const bookIds = await this.getBookIdsByTag(tagId, lang, skip, effectiveLimit);
    const total = await this.countBookIdsByTag(tagId, lang);

    const cardsResponse = await this.buildCardsResponse(
      bookIds,
      lang,
      effectivePage,
      effectiveLimit,
      total,
    );

    let tagResult: Record<string, unknown> | null = null;
    if (includeTag) {
      const tag = await this.prisma.tag.findUnique({
        where: { id: tagId },
        select: {
          id: true,
          key: true,
          slug: true,
          name: true,
          indexable: true,
          isVisible: true,
          sortOrder: true,
        },
      });
      if (tag) {
        tagResult = {
          id: tag.id,
          key: tag.key,
          slug: matchedTranslation?.slug ?? tag.slug,
          name: matchedTranslation?.name ?? tag.name,
          indexable: tag.indexable,
          isVisible: tag.isVisible,
          sortOrder: tag.sortOrder,
          booksCount: total,
          language: lang,
          translation: matchedTranslation,
          translations: matchedTranslation ? [matchedTranslation] : [],
        };
      }
    }

    return {
      tag: tagResult,
      items: cardsResponse.items,
      pagination: cardsResponse.pagination,
    };
  }

  private async getBookIdsByCategory(
    categoryId: string,
    lang: Language,
    skip: number,
    take: number,
  ): Promise<string[]> {
    const versions = await this.prisma.bookVersion.findMany({
      where: {
        language: lang,
        status: 'published',
        categories: { some: { categoryId } },
      },
      select: { id: true, bookId: true },
      distinct: ['bookId'],
      skip,
      take,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    });
    return versions.map((v) => v.bookId);
  }

  private async countBookIdsByCategory(categoryId: string, lang: Language): Promise<number> {
    const groups = await this.prisma.bookVersion.groupBy({
      by: ['bookId'],
      where: {
        language: lang,
        status: 'published',
        categories: { some: { categoryId } },
      },
    });
    return groups.length;
  }

  private async getBookIdsByTag(
    tagId: string,
    lang: Language,
    skip: number,
    take: number,
  ): Promise<string[]> {
    const versions = await this.prisma.bookVersion.findMany({
      where: {
        language: lang,
        status: 'published',
        tags: { some: { tagId } },
      },
      select: { id: true, bookId: true },
      distinct: ['bookId'],
      skip,
      take,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    });
    return versions.map((v) => v.bookId);
  }

  private async countBookIdsByTag(tagId: string, lang: Language): Promise<number> {
    const groups = await this.prisma.bookVersion.groupBy({
      by: ['bookId'],
      where: {
        language: lang,
        status: 'published',
        tags: { some: { tagId } },
      },
    });
    return groups.length;
  }

  /**
   * Build a BookCardDto[] response from a set of bookIds for a language.
   * Shared by findCards / findCardsByAuthor / findCardsByCategory / findCardsByTag.
   */
  private async buildCardsResponse(
    bookIds: string[],
    lang: Language,
    page: number,
    limit: number,
    total: number,
  ): Promise<{
    items: BookCardDto[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    if (bookIds.length === 0) {
      return {
        items: [],
        pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
      };
    }

    // Fetch one localized published version per book (the first by publishedAt desc)
    const versions = await this.prisma.bookVersion.findMany({
      where: { bookId: { in: bookIds }, language: lang, status: 'published' },
      select: this.bookCardSelect(),
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    });

    // Deduplicate by bookId (keep first = latest publishedAt), preserve bookIds order
    const byBookId = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      if (!byBookId.has(v.bookId)) byBookId.set(v.bookId, v);
    }
    const ordered = bookIds
      .map((id) => byBookId.get(id))
      .filter((v): v is (typeof versions)[number] => !!v);

    const ratingsMap = await this.getRatingsForBooks(bookIds);
    const authorIds = Array.from(
      new Set(ordered.map((v) => v.authorId).filter((id): id is string => !!id)),
    );
    const authorSlugMap = await this.getAuthorSlugs(authorIds, lang);

    return {
      items: ordered.map((v) => this.toBookCardDto(v, ratingsMap, authorSlugMap)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Prisma `select` for a compact BookCard row (only fields used by BookCard).
   */
  private bookCardSelect() {
    return {
      id: true,
      bookId: true,
      slug: true,
      title: true,
      author: true,
      authorId: true,
      coverImageUrl: true,
      type: true,
      publishedAt: true,
      _count: { select: { chapters: true, audioChapters: true } },
      categories: { select: { categoryId: true } },
    } as const satisfies Prisma.BookVersionSelect;
  }

  private comparePublishedAtDesc(a: Date | null | undefined, b: Date | null | undefined): number {
    if (!a && !b) return 0;
    if (!a) return 1; // nulls last
    if (!b) return -1;
    return b.getTime() - a.getTime();
  }

  private async getRatingsForBooks(
    bookIds: string[],
  ): Promise<Map<string, { avg: number | null; count: number }>> {
    if (bookIds.length === 0) return new Map();
    const groups = await this.prisma.bookRating.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds } },
      _avg: { score: true },
      _count: { score: true },
    });
    const map = new Map<string, { avg: number | null; count: number }>();
    for (const g of groups) {
      map.set(g.bookId, { avg: g._avg.score ?? null, count: g._count.score });
    }
    return map;
  }

  private async getAuthorSlugs(authorIds: string[], lang: Language): Promise<Map<string, string>> {
    if (authorIds.length === 0) return new Map();
    // Prefer translation for the requested language; fallback to English; then any.
    const translations = await this.prisma.authorTranslation.findMany({
      where: { authorId: { in: authorIds }, language: { in: [lang, Language.en] } },
      select: { authorId: true, language: true, slug: true },
    });
    const map = new Map<string, string>();
    for (const t of translations) {
      // First-wins preference: requested lang over en
      if (!map.has(t.authorId) || t.language === lang) {
        map.set(t.authorId, t.slug);
      }
    }
    return map;
  }

  private toBookCardDto(
    version: {
      id: string;
      bookId: string;
      slug: string | null;
      title: string;
      author: string;
      authorId: string | null;
      coverImageUrl: string | null;
      type: BookType;
      publishedAt: Date | null;
      _count: { chapters: number; audioChapters: number };
      categories: { categoryId: string }[];
    },
    ratingsMap: Map<string, { avg: number | null; count: number }>,
    authorSlugMap: Map<string, string>,
  ): BookCardDto {
    const rating = ratingsMap.get(version.bookId);
    const hasText = version._count.chapters > 0 || version.type === BookType.text;
    const hasAudio = version._count.audioChapters > 0;
    return {
      id: version.bookId,
      slug: version.slug ?? version.id,
      title: version.title,
      author: version.author,
      authorSlug: version.authorId ? (authorSlugMap.get(version.authorId) ?? null) : null,
      coverImageUrl: version.coverImageUrl,
      rating: rating?.avg ?? null,
      ratingsCount: rating?.count ?? 0,
      hasText,
      hasAudio,
      publishedAt: version.publishedAt ? version.publishedAt.toISOString() : null,
      categoryIds: version.categories.map((c) => c.categoryId),
    };
  }

  async update(id: string, data: UpdateBookDto) {
    const book = await this.prisma.book.findUnique({ where: { id } });
    if (!book) {
      throw new NotFoundException(`Book with ID ${id} not found`);
    }

    return this.prisma.book.update({ where: { id }, data });
  }

  async remove(id: string) {
    const book = await this.prisma.book.findUnique({ where: { id } });
    if (!book) {
      throw new NotFoundException(`Book with ID ${id} not found`);
    }

    return this.prisma.book.delete({ where: { id } });
  }

  /**
   * Check if a slug exists for books.
   * @param slug - The slug to check
   * @param excludeId - Optional book ID to exclude (when editing)
   * @returns The existing book or null if slug is available
   */
  async checkSlugExists(slug: string, excludeId?: string) {
    const where: { slug: string; NOT?: { id: string } } = {
      slug,
    };

    if (excludeId) {
      where.NOT = { id: excludeId };
    }

    return this.prisma.book.findFirst({
      where,
      select: { id: true, slug: true },
    });
  }

  /**
   * Generate a unique slug by appending a numeric suffix.
   * @param baseSlug - The base slug to make unique
   * @returns A unique slug with numeric suffix (e.g., "harry-potter-2")
   */
  async generateUniqueSuggestedSlug(baseSlug: string): Promise<string> {
    let suffix = 2;
    let candidateSlug = `${baseSlug}-${suffix}`;

    // Find first available suffix
    while (await this.checkSlugExists(candidateSlug)) {
      suffix++;
      candidateSlug = `${baseSlug}-${suffix}`;
    }

    return candidateSlug;
  }

  /**
   * Get all unique themes across all book versions.
   */
  async getAllThemes(): Promise<string[]> {
    const versions = await this.prisma.bookVersion.findMany({
      where: {
        NOT: {
          themes: {
            equals: Prisma.DbNull,
          },
        },
      },
      select: {
        themes: true,
      },
    });

    const uniqueThemes = new Set<string>();
    for (const v of versions) {
      if (Array.isArray(v.themes)) {
        for (const t of v.themes) {
          if (typeof t === 'string' && t.trim()) {
            uniqueThemes.add(t.trim());
          }
        }
      }
    }
    return Array.from(uniqueThemes).sort();
  }

  /**
   * Get Reader bootstrap data in a single request.
   */
  async getReaderBootstrap(slug: string, lang: string, userId?: string) {
    let overview: Awaited<ReturnType<BookService['getOverview']>>;
    try {
      overview = await this.getOverview(slug, lang);
    } catch (err) {
      if (err instanceof RedirectException) {
        // The RedirectException url has format: /api/[lang]/books/[targetSlug]/overview or /api/books/[targetSlug]/overview?lang=...
        // We can extract the target slug from the URL to bypass redirection
        const match = err.url.match(/\/books\/([^/]+)\/overview/);
        if (match && match[1]) {
          overview = await this.getOverview(match[1], lang);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const textVersionId = overview.versionIds.text;
    let lastProgressChapterNumber: number | null = null;
    let lastProgressPosition = 0;
    let hasProgress = false;

    if (userId && textVersionId) {
      // 1. Try to find progress for the requested language version first
      const progress = await this.prisma.readingProgress.findFirst({
        where: {
          userId,
          bookVersionId: textVersionId,
        },
      });

      if (progress) {
        lastProgressChapterNumber = progress.chapterNumber;
        lastProgressPosition = progress.position;
        hasProgress = true;
      } else {
        // 2. Fallback: find progress in any other version of this book, ordered by latest updated
        const allVersionIds = overview.versions.map((v) => v.id);
        const fallbackProgress = await this.prisma.readingProgress.findFirst({
          where: {
            userId,
            bookVersionId: { in: allVersionIds },
          },
          include: {
            bookVersion: true,
          },
          orderBy: {
            updatedAt: 'desc',
          },
        });

        if (fallbackProgress && fallbackProgress.bookVersion.type === BookType.text) {
          lastProgressChapterNumber = fallbackProgress.chapterNumber;
          lastProgressPosition = fallbackProgress.position;
          hasProgress = true;
        }
      }
    }

    if (!textVersionId) {
      throw new NotFoundException(`No text version found for book slug "${slug}"`);
    }

    // Fetch chapters
    const chapters = await this.prisma.chapter.findMany({
      where: { bookVersionId: textVersionId },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        number: true,
        title: true,
        content: true,
      },
    });

    return {
      bookId: overview.id,
      versionId: textVersionId,
      slug: overview.slug,
      title: overview.title,
      author: overview.author,
      chapters,
      lastProgress: hasProgress
        ? {
            chapterNumber: lastProgressChapterNumber,
            position: lastProgressPosition,
          }
        : null,
    };
  }
}
