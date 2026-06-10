import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { BookType } from '@prisma/client';
import { resolveRequestedLanguage } from '../../shared/language/language.util';

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

  private async getAverageRating(bookId: string): Promise<number> {
    const agg = await this.prisma.bookRating.aggregate({
      where: { bookId },
      _avg: { score: true },
    });
    return agg._avg.score || 5.0;
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
          (v) => v.status === 'published' && (v._count?.audioChapters > 0 || v.type === 'audio'),
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
    const book = await this.prisma.book.findUnique({
      where: { slug },
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
    const book = await this.prisma.book.findUnique({ where: { slug } });
    if (!book) throw new NotFoundException(`Book with slug ${slug} not found`);

    // All published versions for this book
    const versions = await this.prisma.bookVersion.findMany({
      where: { bookId: book.id, status: 'published' },
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

    // We can read it if it is preferredLang and has chapters OR has type text, or fallback to first version with chapters/text
    const textVersion =
      versions.find(
        (v) => v.language === preferredLang && (v._count.chapters > 0 || v.type === BookType.text),
      ) ||
      versions.find((v) => v._count.chapters > 0 || v.type === BookType.text) ||
      null;

    // We can listen if it is preferredLang and has audioChapters OR has type audio
    const audioVersion =
      versions.find(
        (v) =>
          v.language === preferredLang && (v._count.audioChapters > 0 || v.type === BookType.audio),
      ) || null;

    // Pick referral version
    const referralVersion =
      versions.find((v) => v.language === preferredLang && v.type === BookType.referral) ||
      versions.find((v) => v.type === BookType.referral) ||
      null;

    // Check features
    const hasText =
      !!textVersion && (textVersion._count.chapters > 0 || textVersion.type === BookType.text);
    const hasAudio =
      !!audioVersion &&
      (audioVersion._count.audioChapters > 0 || audioVersion.type === BookType.audio);

    // Summary exists if BookSummary row exists for any version
    const hasSummary = versions.some((v) => v._count.summaries > 0);

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

    const activeVersion = textVersion || audioVersion || referralVersion;

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

    return {
      id: book.id,
      slug: book.slug,
      title: activeVersion?.title || '',
      author: activeVersion?.author || '',
      description: activeVersion?.description || '',
      coverUrl: activeVersion?.coverImageUrl || '',
      rating: await this.getAverageRating(book.id),
      publicationYear: activeVersion?.publishedAt
        ? new Date(activeVersion.publishedAt).getFullYear()
        : null,
      language: preferredLang,
      categories,
      tags,
      versions: versions.map((v) => ({
        ...v,
        coverUrl: v.coverImageUrl, // compatibility alias
      })),
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      // Keep legacy structure properties for compatibility
      book: { id: book.id, slug: book.slug },
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
}
