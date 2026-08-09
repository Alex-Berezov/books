import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { Language, Prisma } from '@prisma/client';
import {
  AuthorQuoteDto as AuthorQuote,
  AuthorFaqDto as AuthorFaq,
} from './dto/author-translation.dto';

@Injectable()
export class AuthorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Сколько **опубликованных книг** у каждого из авторов — батчем.
   *
   * 🔴 Считать по внешнему ключу `BookVersion.authorId`, как было до 09.08.2026,
   * нельзя: в проде он NULL у всех опубликованных версий, и `_count.bookVersions`
   * давал ноль **всем десяти** авторам, включая тех, чьи книги лежат в каталоге.
   * Фактическая связь держится на строковом поле `BookVersion.author`.
   *
   * Поэтому здесь тот же fallback, что уже работает поштучно в
   * `getPublicBySlug`: `authorId` **или** совпадение имени. Имя при этом
   * сравнивается со своим языком (`bv.language = t.language`) — в ru-версии книги
   * автор записан как «Сунь-цзы», и сверять его с английским «Sun Tzu» было бы
   * бессмысленно.
   *
   * Считаются различные **книги**, а не версии: одна книга в трёх языках — одна
   * книга, иначе счётчик мерил бы полноту перевода, а не наполненность автора.
   */
  private async countPublishedBooksByAuthor(
    authorIds: string[],
    lang?: Language,
  ): Promise<Map<string, number>> {
    if (authorIds.length === 0) return new Map();

    const conditions: Prisma.Sql[] = [Prisma.sql`t."authorId" IN (${Prisma.join(authorIds)})`];
    if (lang) {
      conditions.push(Prisma.sql`t.language = ${lang}::"Language"`);
    }

    const rows = await this.prisma.$queryRaw<Array<{ authorId: string; booksCount: number }>>`
      SELECT t."authorId", COUNT(DISTINCT bv."bookId")::int AS "booksCount"
      FROM "AuthorTranslation" t
      JOIN "BookVersion" bv
        ON bv.language = t.language
       AND bv.status = 'published'
       AND (bv."authorId" = t."authorId" OR bv.author = t.name)
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY t."authorId"
    `;

    return new Map(rows.map((r) => [r.authorId, r.booksCount]));
  }

  /**
   * @param lang Язык публичного списка. Когда задан, автор без перевода на него
   * из выдачи исключается: страницы на этом языке у него нет вовсе, и ссылка
   * вела бы в 404 (soft-404 закрыт 05.08.2026). Админский список ходит без
   * языка и видит всех.
   */
  async list(page = 1, limit = 20, lang?: Language) {
    const skip = (page - 1) * limit;
    const where: Prisma.AuthorWhereInput | undefined = lang
      ? { translations: { some: { language: lang } } }
      : undefined;

    const [total, items] = await this.prisma.$transaction([
      this.prisma.author.count({ where }),
      this.prisma.author.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          translations: {
            include: { seo: true },
          },
        },
      }),
    ]);

    const booksCounts = await this.countPublishedBooksByAuthor(
      items.map((item) => item.id),
      lang,
    );

    return {
      data: items.map((item) => {
        // С языком — перевод на него (он гарантированно есть, список по нему и
        // отфильтрован). Без языка это админская выдача, там прежний порядок:
        // английский, иначе первый попавшийся.
        const mainTrans = lang
          ? item.translations.find((t) => t.language === lang)
          : item.translations.find((t) => t.language === 'en') || item.translations[0];

        return {
          id: item.id,
          slug: mainTrans?.slug || '',
          name: mainTrans?.name || '',
          birthDate: item.birthDate,
          deathDate: item.deathDate,
          wikidataUrl: mainTrans?.wikidataUrl || null,
          wikipediaUrl: mainTrans?.wikipediaUrl || null,
          photoUrl: mainTrans?.photoUrl || null,
          translations: item.translations,
          booksCount: booksCounts.get(item.id) ?? 0,
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(dto: CreateAuthorDto) {
    // Determine the photo to sync across all translations
    // Find the first translation that contains a non-empty photoUrl
    const syncedPhotoUrl = dto.translations.find((t) => t.photoUrl)?.photoUrl || null;

    // Check slug uniqueness in translations table for all translations
    for (const t of dto.translations) {
      const existingTrans = await this.prisma.authorTranslation.findFirst({
        where: { language: t.language, slug: t.slug },
      });
      if (existingTrans) {
        throw new BadRequestException(
          `Author translation with slug '${t.slug}' for language '${t.language}' already exists`,
        );
      }
    }

    try {
      return await this.prisma.author.create({
        data: {
          birthDate: dto.birthDate,
          deathDate: dto.deathDate,
          translations: {
            create: dto.translations.map((t) => ({
              language: t.language,
              slug: t.slug,
              name: t.name,
              biography: t.biography,
              wikidataUrl: t.wikidataUrl,
              wikipediaUrl: t.wikipediaUrl,
              photoUrl: t.photoUrl || syncedPhotoUrl,
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

    // Determine the photo to sync across all translations
    let syncedPhotoUrl: string | null | undefined = undefined;
    if (dto.translations) {
      syncedPhotoUrl = dto.translations.find((t) => t.photoUrl)?.photoUrl;
      // If photoUrl is explicitly set in one of translations but others have it empty, we sync it.
      // If none set it but we have an old photo, we might keep it.
    }

    // Validate slugs for uniqueness
    if (dto.translations) {
      for (const t of dto.translations) {
        const existingTrans = await this.prisma.authorTranslation.findFirst({
          where: {
            language: t.language,
            slug: t.slug,
            NOT: { authorId: id },
          },
        });
        if (existingTrans) {
          throw new BadRequestException(
            `Author translation with slug '${t.slug}' for language '${t.language}' already exists`,
          );
        }
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Update main fields
        await tx.author.update({
          where: { id },
          data: {
            birthDate: dto.birthDate,
            deathDate: dto.deathDate,
          },
        });

        // Update translations if provided
        if (dto.translations) {
          // Find old translation's seoIds to delete them to avoid orphans
          const oldTranslations = await tx.authorTranslation.findMany({
            where: { authorId: id },
            select: { seoId: true, photoUrl: true },
          });
          const seoIdsToDelete = oldTranslations
            .map((t) => t.seoId)
            .filter((sid): sid is number => sid !== null);

          // If syncedPhotoUrl is not provided in current translations, fallback to previous photoUrl
          const existingPhoto = oldTranslations.find((t) => t.photoUrl)?.photoUrl || null;
          const finalPhoto = syncedPhotoUrl !== undefined ? syncedPhotoUrl : existingPhoto;

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
                slug: t.slug,
                name: t.name,
                biography: t.biography,
                wikidataUrl: t.wikidataUrl,
                wikipediaUrl: t.wikipediaUrl,
                photoUrl: t.photoUrl || finalPhoto,
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
    const where: Prisma.AuthorTranslationWhereInput = { slug };
    if (excludeId) {
      where.NOT = { authorId: excludeId };
    }
    const authorTrans = await this.prisma.authorTranslation.findFirst({ where });
    return authorTrans;
  }

  async getPublicBySlug(slug: string, language: Language) {
    // Find translation with matching slug and language
    const translation = await this.prisma.authorTranslation.findFirst({
      where: { slug, language },
      include: {
        seo: true,
        author: true,
      },
    });

    if (!translation) {
      throw new NotFoundException(
        `Author with slug '${slug}' for language '${language}' not found`,
      );
    }

    const author = translation.author;

    const quotes = (translation.quotes as unknown as AuthorQuote[]) || [];
    const faq = (translation.faq as unknown as AuthorFaq[]) || [];
    let similarAuthors: { name: string; slug: string }[] = [];
    const similarSlugs = (translation.similarSlugs as unknown as string[]) || [];
    if (similarSlugs.length > 0) {
      const dbSimilar = await this.prisma.authorTranslation.findMany({
        where: { slug: { in: similarSlugs }, language },
        select: { name: true, slug: true },
      });
      similarAuthors = dbSimilar.map((sa) => ({
        slug: sa.slug,
        name: sa.name,
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
      slug: translation.slug,
      birthDate: author.birthDate,
      deathDate: author.deathDate,
      wikidataUrl: translation.wikidataUrl,
      wikipediaUrl: translation.wikipediaUrl,
      photoUrl: translation.photoUrl,
      name: translation.name,
      biography: translation.biography,
      quotes,
      faq,
      seo: translation.seo,
      similarAuthors,
      books: await Promise.all(
        bookVersions.map(async (bv) => {
          const agg = await this.prisma.bookRating.aggregate({
            where: { bookId: bv.bookId },
            _avg: { score: true },
          });
          return {
            id: bv.id,
            bookId: bv.bookId,
            slug: bv.slug || bv.book.slug,
            title: bv.title,
            author: bv.author,
            coverImageUrl: bv.coverImageUrl,
            coverUrl: bv.coverImageUrl,
            type: bv.type,
            isFree: bv.isFree,
            rating: agg._avg.score ?? null,
            versions: [
              {
                language: bv.language,
                status: bv.status,
                type: bv.type,
                coverImageUrl: bv.coverImageUrl,
                coverUrl: bv.coverImageUrl,
              },
            ],
          };
        }),
      ),
    };
  }
}
