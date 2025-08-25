import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';
import { BookType, Language } from '@prisma/client';

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
      include: { versions: true },
    });

    if (!book) {
      throw new NotFoundException(`Book with ID ${id} not found`);
    }

    return book;
  }

  async findBySlug(slug: string) {
    const book = await this.prisma.book.findUnique({
      where: { slug },
      include: { versions: true },
    });

    if (!book) {
      throw new NotFoundException(`Book with slug ${slug} not found`);
    }

    return book;
  }

  // Overview aggregation for frontend
  async getOverview(slug: string, lang?: string) {
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

    const preferredLang =
      lang && Object.values(Language).includes(lang as Language) ? (lang as Language) : undefined;

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
}
