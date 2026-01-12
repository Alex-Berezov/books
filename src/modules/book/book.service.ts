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

  async findAll(paginationDto?: PaginationDto) {
    const { page = 1, limit = 10 } = paginationDto || {};
    const skip = (page - 1) * limit;

    const [books, total] = await Promise.all([
      this.prisma.book.findMany({
        include: { versions: true },
        skip,
        take: limit,
      }),
      this.prisma.book.count(),
    ]);

    return {
      data: books,
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

    return {
      ...book,
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

    return {
      ...book,
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
      select: {
        id: true,
        language: true,
        type: true,
        isFree: true,
        seoId: true,
      },
    });

    const availableLanguages = Array.from(new Set(versions.map((v) => v.language)));

    const preferredLang = resolveRequestedLanguage({
      queryLang: lang,
      acceptLanguage: acceptLanguageHeader || null,
      available: availableLanguages,
    });

    // Pick versions by type (closest to requested lang, fallback to first available)
    const pickByType = (type: BookType) => {
      const sameLang = versions.find((v) => v.type === type && v.language === preferredLang);
      if (sameLang) return sameLang;
      return versions.find((v) => v.type === type) || null;
    };

    const textVersion = pickByType(BookType.text);
    const audioVersion = pickByType(BookType.audio);
    const referralVersion = pickByType(BookType.referral);

    // Check features
    const hasText = !!textVersion;
    const hasAudio = !!audioVersion;

    // Summary exists if BookSummary row exists for any selected version
    const summaryForVersionId = textVersion?.id ?? audioVersion?.id ?? referralVersion?.id;
    const summary = summaryForVersionId
      ? await this.prisma.bookSummary.findFirst({
          where: { bookVersionId: summaryForVersionId },
          select: { id: true },
        })
      : null;
    const hasSummary = !!summary;

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

    return {
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
    } as const;
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
