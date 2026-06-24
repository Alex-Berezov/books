import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { Language, Prisma } from '@prisma/client';

@Injectable()
export class AuthorService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [total, items] = await this.prisma.$transaction([
      this.prisma.author.count(),
      this.prisma.author.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          translations: {
            include: { seo: true },
          },
          _count: {
            select: { bookVersions: true },
          },
        },
      }),
    ]);

    return {
      data: items.map((item) => ({
        id: item.id,
        slug: item.slug,
        birthDate: item.birthDate,
        deathDate: item.deathDate,
        wikidataUrl: item.wikidataUrl,
        wikipediaUrl: item.wikipediaUrl,
        photoUrl: item.photoUrl,
        translations: item.translations,
        booksCount: item._count.bookVersions,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(dto: CreateAuthorDto) {
    // Check if slug is unique
    const existing = await this.prisma.author.findUnique({ where: { slug: dto.slug } });
    if (existing) {
      throw new BadRequestException(`Author with slug '${dto.slug}' already exists`);
    }

    try {
      return await this.prisma.author.create({
        data: {
          slug: dto.slug,
          birthDate: dto.birthDate,
          deathDate: dto.deathDate,
          wikidataUrl: dto.wikidataUrl,
          wikipediaUrl: dto.wikipediaUrl,
          photoUrl: dto.photoUrl,
          translations: {
            create: dto.translations.map((t) => ({
              language: t.language,
              name: t.name,
              biography: t.biography,
              quotes: t.quotes as unknown as Prisma.InputJsonValue,
              faq: t.faq as unknown as Prisma.InputJsonValue,
              similarSlugs: t.similarSlugs as unknown as Prisma.InputJsonValue,
              seo: t.seo
                ? {
                    create: {
                      metaTitle: t.seo.metaTitle,
                      metaDescription: t.seo.metaDescription,
                      canonicalUrl: t.seo.canonicalUrl,
                      robots: t.seo.robots,
                      ogTitle: t.seo.ogTitle,
                      ogDescription: t.seo.ogDescription,
                      ogImageUrl: t.seo.ogImageUrl,
                      ogImageAlt: t.seo.ogImageAlt,
                      twitterCard: t.seo.twitterCard,
                    },
                  }
                : undefined,
            })),
          },
        },
        include: {
          translations: {
            include: { seo: true },
          },
        },
      });
    } catch (error) {
      throw new BadRequestException('Failed to create author: ' + (error as Error).message);
    }
  }

  async update(id: string, dto: UpdateAuthorDto) {
    const author = await this.prisma.author.findUnique({ where: { id } });
    if (!author) {
      throw new NotFoundException(`Author with ID '${id}' not found`);
    }

    if (dto.slug && dto.slug !== author.slug) {
      const existing = await this.prisma.author.findUnique({ where: { slug: dto.slug } });
      if (existing) {
        throw new BadRequestException(`Author with slug '${dto.slug}' already exists`);
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Update main fields
        await tx.author.update({
          where: { id },
          data: {
            slug: dto.slug,
            birthDate: dto.birthDate,
            deathDate: dto.deathDate,
            wikidataUrl: dto.wikidataUrl,
            wikipediaUrl: dto.wikipediaUrl,
            photoUrl: dto.photoUrl,
          },
        });

        // Update translations if provided
        if (dto.translations) {
          // Find old translation's seoIds to delete them to avoid orphans
          const oldTranslations = await tx.authorTranslation.findMany({
            where: { authorId: id },
            select: { seoId: true },
          });
          const seoIdsToDelete = oldTranslations
            .map((t) => t.seoId)
            .filter((sid): sid is number => sid !== null);

          // Delete existing translations (which sets their relations to null)
          await tx.authorTranslation.deleteMany({ where: { authorId: id } });

          // Clean up old Seo records
          if (seoIdsToDelete.length > 0) {
            await tx.seo.deleteMany({ where: { id: { in: seoIdsToDelete } } });
          }

          // Re-create translations
          for (const t of dto.translations) {
            await tx.authorTranslation.create({
              data: {
                author: { connect: { id } },
                language: t.language,
                name: t.name,
                biography: t.biography,
                quotes: t.quotes as unknown as Prisma.InputJsonValue,
                faq: t.faq as unknown as Prisma.InputJsonValue,
                similarSlugs: t.similarSlugs as unknown as Prisma.InputJsonValue,
                seo: t.seo
                  ? {
                      create: {
                        metaTitle: t.seo.metaTitle,
                        metaDescription: t.seo.metaDescription,
                        canonicalUrl: t.seo.canonicalUrl,
                        robots: t.seo.robots,
                        ogTitle: t.seo.ogTitle,
                        ogDescription: t.seo.ogDescription,
                        ogImageUrl: t.seo.ogImageUrl,
                        ogImageAlt: t.seo.ogImageAlt,
                        twitterCard: t.seo.twitterCard,
                      },
                    }
                  : undefined,
              },
            });
          }
        }

        return tx.author.findUnique({
          where: { id },
          include: {
            translations: {
              include: { seo: true },
            },
          },
        });
      });
    } catch (error) {
      throw new BadRequestException('Failed to update author: ' + (error as Error).message);
    }
  }

  async delete(id: string) {
    const author = await this.prisma.author.findUnique({ where: { id } });
    if (!author) {
      throw new NotFoundException(`Author with ID '${id}' not found`);
    }
    return this.prisma.author.delete({ where: { id } });
  }

  async checkSlugExists(slug: string, excludeId?: string) {
    const where: Prisma.AuthorWhereInput = { slug };
    if (excludeId) {
      where.NOT = { id: excludeId };
    }
    const author = await this.prisma.author.findFirst({ where });
    return author;
  }

  async getPublicBySlug(slug: string, language: Language) {
    const author = await this.prisma.author.findUnique({
      where: { slug },
      include: {
        translations: {
          where: { language },
          include: { seo: true },
        },
      },
    });

    if (!author) {
      throw new NotFoundException(`Author with slug '${slug}' not found`);
    }

    const translation = author.translations[0];
    if (!translation) {
      throw new NotFoundException(
        `Translation for language '${language}' not found for author '${slug}'`,
      );
    }

    // Get similar authors translations
    let similarAuthors: { name: string; slug: string }[] = [];
    const similarSlugs = (translation.similarSlugs as string[]) || [];
    if (similarSlugs.length > 0) {
      const dbSimilar = await this.prisma.author.findMany({
        where: { slug: { in: similarSlugs } },
        include: {
          translations: {
            where: { language },
            select: { name: true },
          },
        },
      });
      similarAuthors = dbSimilar.map((sa) => ({
        slug: sa.slug,
        name: sa.translations[0]?.name || sa.slug,
      }));
    }

    // Get books by this author
    // Fallback: match by authorId OR by string match of author's name
    const bookVersions = await this.prisma.bookVersion.findMany({
      where: {
        language,
        status: 'published',
        OR: [{ authorId: author.id }, { author: translation.name }],
      },
      include: {
        book: {
          select: {
            id: true,
            slug: true,
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
    });

    return {
      id: author.id,
      slug: author.slug,
      birthDate: author.birthDate,
      deathDate: author.deathDate,
      wikidataUrl: author.wikidataUrl,
      wikipediaUrl: author.wikipediaUrl,
      photoUrl: author.photoUrl,
      name: translation.name,
      biography: translation.biography,
      quotes: translation.quotes,
      faq: translation.faq,
      seo: translation.seo,
      similarAuthors,
      books: bookVersions.map((bv) => ({
        id: bv.id,
        bookId: bv.bookId,
        slug: bv.slug || bv.book.slug,
        title: bv.title,
        author: bv.author,
        coverImageUrl: bv.coverImageUrl,
        type: bv.type,
        isFree: bv.isFree,
        rating: 4.8, // Fallback if ratings are calculated
        versions: [
          {
            language: bv.language,
            status: bv.status,
            type: bv.type,
          },
        ],
      })),
    };
  }
}
