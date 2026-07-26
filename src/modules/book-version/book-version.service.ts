import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookVersionDto } from './dto/create-book-version.dto';
import { UpdateBookVersionDto } from './dto/update-book-version.dto';
import { PublicationGateService } from './publication-gate.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { UpdateRightsGeoBlockDto } from './dto/publication-gate-result.dto';
import { Prisma } from '@prisma/client';
import { Language, BookType } from '@prisma/client';
import { randomUUID } from 'crypto';

interface BookWithRights {
  id: string;
  rightsIntakeId: string | null;
  currentRightsProfileId: string | null;
  approvedRightsReviewId: string | null;
}

interface RightsIntakeWithLanguages {
  id: string;
  targetLanguages: string[];
}

interface SiblingVersionWithRights {
  id: string;
  primaryCategoryId: string | null;
  rightsProfileId: string | null;
  approvedRightsReviewId: string | null;
  rightsStatus: string | null;
  rightsAllowedCountryCodes: unknown;
  rightsBlockedCountryCodes: unknown;
  rightsLicenseRequiredCountryCodes: unknown;
  rightsPendingCountryCodes: unknown;
  rightsRequiredActions: unknown;
  rightsGeoBlockRequired: boolean | null;
  rightsGeoBlockConfigured: boolean | null;
  rightsGeoBlockConfiguredAt: Date | null;
  rightsGeoBlockNotesRu: string | null;
}

@Injectable()
export class BookVersionService {
  constructor(
    private prisma: PrismaService,
    private publicationGateService: PublicationGateService,
    private rightsContentHashService: RightsContentHashService,
  ) {}

  async list(
    bookId: string,
    filters: { language?: Language; type?: BookType; isFree?: boolean },
    acceptLanguageHeader?: string,
  ) {
    const where: Prisma.BookVersionWhereInput = {
      bookId,
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
      status: 'published',
    };
    // If no explicit language filter is provided, apply Accept-Language fallback to prefer one language
    if (!filters.language && acceptLanguageHeader) {
      const all = await this.prisma.bookVersion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { seo: true },
      });
      const available = Array.from(new Set(all.map((v) => v.language)));
      const { resolveRequestedLanguage } = await import('../../shared/language/language.util');
      const preferred = resolveRequestedLanguage({
        acceptLanguage: acceptLanguageHeader,
        available,
      });
      return preferred ? all.filter((v) => v.language === preferred) : all;
    }
    return this.prisma.bookVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
  }

  async create(bookId: string, dto: CreateBookVersionDto, overrideLanguage?: Language) {
    const effectiveLanguage = overrideLanguage ?? dto.language;

    // Get book with rights intake to check clearance
    const book = (await this.prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        rightsIntakeId: true,
        currentRightsProfileId: true,
        approvedRightsReviewId: true,
      },
    })) as unknown as BookWithRights | null;

    if (!book) {
      throw new NotFoundException(`Book with ID ${bookId} not found`);
    }

    // Check if book has rights clearance
    if (!book.rightsIntakeId) {
      throw new BadRequestException(
        'Cannot create version for a book without approved rights clearance',
      );
    }

    // Get rights intake to check target languages
    const rightsIntake = (await this.prisma.rightsIntake.findUnique({
      where: { id: book.rightsIntakeId },
      select: {
        id: true,
        targetLanguages: true,
      },
    })) as unknown as RightsIntakeWithLanguages | null;

    // Check if language is in approved target languages
    if (
      rightsIntake?.targetLanguages &&
      !rightsIntake.targetLanguages.includes(effectiveLanguage)
    ) {
      throw new BadRequestException(
        `Language ${effectiveLanguage} is not in approved target languages for this book`,
      );
    }

    const existing = await this.prisma.bookVersion.findFirst({
      where: { bookId, language: effectiveLanguage },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Version for this language already exists for this book');
    }

    let version;
    try {
      version = await this.prisma.$transaction(async (tx) => {
        let seoId: number | undefined;
        if (dto.seoMetaTitle || dto.seoMetaDescription) {
          const seo = await tx.seo.create({
            data: {
              metaTitle: dto.seoMetaTitle,
              metaDescription: dto.seoMetaDescription,
            },
          });
          seoId = seo.id;
        }

        // Search for any existing sibling version of this book to copy tags/categories from

        const siblingVersion = (await tx.bookVersion.findFirst({
          where: { bookId },
          orderBy: { createdAt: 'asc' },
        })) as unknown as SiblingVersionWithRights | null;

        const effectivePrimaryCategoryId =
          dto.primaryCategoryId || siblingVersion?.primaryCategoryId || undefined;

        // Copy rights snapshot from sibling version or book's current profile
        const rightsProfileId = siblingVersion?.rightsProfileId || book.currentRightsProfileId;
        const approvedRightsReviewId =
          siblingVersion?.approvedRightsReviewId || book.approvedRightsReviewId;
        const rightsStatus = siblingVersion?.rightsStatus;
        const rightsAllowedCountryCodes = siblingVersion?.rightsAllowedCountryCodes;
        const rightsBlockedCountryCodes = siblingVersion?.rightsBlockedCountryCodes;
        const rightsLicenseRequiredCountryCodes = siblingVersion?.rightsLicenseRequiredCountryCodes;
        const rightsPendingCountryCodes = siblingVersion?.rightsPendingCountryCodes;
        const rightsRequiredActions = siblingVersion?.rightsRequiredActions;

        // Copy geo-block fields from sibling or compute from profile/context
        const rightsGeoBlockRequired = siblingVersion?.rightsGeoBlockRequired ?? false;
        const rightsGeoBlockConfigured = siblingVersion?.rightsGeoBlockConfigured ?? false;
        const rightsGeoBlockConfiguredAt = siblingVersion?.rightsGeoBlockConfiguredAt ?? null;
        const rightsGeoBlockNotesRu = siblingVersion?.rightsGeoBlockNotesRu ?? null;

        const newVersion = await tx.bookVersion.create({
          data: {
            bookId,
            language: effectiveLanguage,
            title: dto.title,
            author: dto.author,
            description: dto.description,
            coverImageUrl: dto.coverImageUrl,
            type: dto.type,
            isFree: dto.isFree,
            referralUrl: dto.referralUrl,
            seoId,
            status: 'draft',
            slug: dto.slug,
            primaryCategoryId: effectivePrimaryCategoryId,
            firstPublishedYear: dto.firstPublishedYear,
            editionPublishedYear: dto.editionPublishedYear,
            originalLanguage: dto.originalLanguage,
            copyrightStatus: dto.copyrightStatus,
            authorPageUrl: dto.authorPageUrl,
            authorId: dto.authorId,
            characters: (dto.characters as Prisma.JsonValue) ?? undefined,
            quotes: (dto.quotes as Prisma.JsonValue) ?? undefined,
            faq: (dto.faq as Prisma.JsonValue) ?? undefined,
            themes: (dto.themes as Prisma.JsonValue) ?? undefined,
            originalTitle: dto.originalTitle,
            alternativeTitles: (dto.alternativeTitles as Prisma.JsonValue) ?? undefined,
            shortDescription: dto.shortDescription,
            summaryShort: dto.summaryShort,
            symbols: (dto.symbols as Prisma.JsonValue) ?? undefined,
            coverAlt: dto.coverAlt,
            // Rights fields from clearance
            rightsProfileId,
            approvedRightsReviewId,
            rightsStatus,
            rightsAllowedCountryCodes: rightsAllowedCountryCodes as Prisma.InputJsonValue,
            rightsBlockedCountryCodes: rightsBlockedCountryCodes as Prisma.InputJsonValue,
            rightsLicenseRequiredCountryCodes:
              rightsLicenseRequiredCountryCodes as Prisma.InputJsonValue,
            rightsPendingCountryCodes: rightsPendingCountryCodes as Prisma.InputJsonValue,
            rightsRequiredActions: rightsRequiredActions as Prisma.InputJsonValue,
            // Phase 7: geo-block fields
            rightsGeoBlockRequired,
            rightsGeoBlockConfigured,
            rightsGeoBlockConfiguredAt,
            rightsGeoBlockNotesRu,
          } as Prisma.BookVersionUncheckedCreateInput & {
            rightsGeoBlockRequired: boolean;
            rightsGeoBlockConfigured: boolean;
            rightsGeoBlockConfiguredAt: Date | null;
            rightsGeoBlockNotesRu: string | null;
          },
          include: { seo: true },
        });

        // Copy categories and tags if sibling version exists
        if (siblingVersion) {
          const siblingCategories = await tx.bookCategory.findMany({
            where: { bookVersionId: siblingVersion.id },
            select: { categoryId: true },
          });
          if (siblingCategories.length > 0) {
            await tx.bookCategory.createMany({
              data: siblingCategories.map((c) => ({
                id: randomUUID(),
                bookVersionId: newVersion.id,
                categoryId: c.categoryId,
              })),
            });
          }
          const siblingTags = await tx.bookTag.findMany({
            where: { bookVersionId: siblingVersion.id },
            select: { tagId: true },
          });
          if (siblingTags.length > 0) {
            await tx.bookTag.createMany({
              data: siblingTags.map((t) => ({
                id: randomUUID(),
                bookVersionId: newVersion.id,
                tagId: t.tagId,
              })),
            });
          }
        }

        await this.rightsContentHashService.initializeVersionBaseline(
          newVersion.id,
          'INITIAL_VERSION_SNAPSHOT',
          null,
          tx,
        );

        return newVersion;
      });
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Version for this language already exists for this book');
      }
      throw e;
    }

    return version;
  }

  async getPublic(id: string) {
    const version = await this.prisma.bookVersion.findFirst({
      where: { id, status: 'published' },
      include: {
        seo: true,
        categories: {
          include: { category: true },
        },
        tags: {
          include: { tag: true },
        },
      },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    return {
      ...version,
      categories: version.categories.map((c) => c.category),
      tags: version.tags.map((t) => t.tag),
    };
  }

  // Админский доступ — любая версия
  async getAdmin(id: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id },
      include: {
        seo: true,
        book: { select: { slug: true } },
        categories: {
          include: { category: true },
        },
        tags: {
          include: { tag: true },
        },
      },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    // Добавляем bookSlug к результату
    return {
      ...version,
      bookSlug: version.book.slug,
      categories: version.categories.map((c) => c.category),
      tags: version.tags.map((t) => t.tag),
    };
  }

  async update(id: string, dto: UpdateBookVersionDto) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    if (dto.previewMediaId) {
      const media = await this.prisma.mediaAsset.findUnique({
        where: { id: dto.previewMediaId },
        select: { id: true, contentType: true, isDeleted: true },
      });
      if (!media || media.isDeleted) {
        throw new BadRequestException('previewMediaId references a non-existent MediaAsset');
      }
      if (!media.contentType || !media.contentType.startsWith('audio/')) {
        throw new BadRequestException('previewMediaId must reference an audio MediaAsset');
      }
    }

    const hasNonSeoFields = Object.keys(dto).some(
      (k) => k !== 'seoMetaTitle' && k !== 'seoMetaDescription',
    );

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        let seoId = existing.seoId;
        if (dto.seoMetaTitle !== undefined || dto.seoMetaDescription !== undefined) {
          if (seoId) {
            await tx.seo.update({
              where: { id: seoId },
              data: {
                metaTitle: dto.seoMetaTitle,
                metaDescription: dto.seoMetaDescription,
              },
            });
          } else {
            const seo = await tx.seo.create({
              data: {
                metaTitle: dto.seoMetaTitle,
                metaDescription: dto.seoMetaDescription,
              },
            });
            seoId = seo.id;
          }
        }
        // Убираем SEO поля из DTO, так как они не существуют в BookVersion schema
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { seoMetaTitle, seoMetaDescription, ...updateData } = dto;
        const updated = await tx.bookVersion.update({
          where: { id },
          data: {
            ...updateData,
            seoId,
          },
          include: { seo: true },
        });

        // Phase 8: Stale detection - skip if only SEO fields changed
        if (hasNonSeoFields) {
          await this.rightsContentHashService.checkVersionStaleness(
            id,
            'BOOK_VERSION_UPDATED',
            null,
            true,
            tx,
          );
        }

        return updated;
      });

      return updated;
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Version for this language already exists for this book');
      }
      throw e;
    }
  }

  async getPreview(id: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id },
      select: {
        status: true,
        previewMediaId: true,
        previewMedia: {
          select: { url: true, duration: true, contentType: true, isDeleted: true },
        },
      },
    });
    if (!version || version.status !== 'published') {
      throw new NotFoundException('Version not found');
    }
    if (!version.previewMediaId || !version.previewMedia || version.previewMedia.isDeleted) {
      throw new NotFoundException('Preview not available');
    }
    return {
      previewUrl: version.previewMedia.url,
      duration: version.previewMedia.duration,
      contentType: version.previewMedia.contentType,
    };
  }

  async remove(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.delete({
      where: { id },
      include: { seo: true },
    });
  }

  async publish(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');

    await this.publicationGateService.assertVersionCanPublish(id);

    return this.prisma.bookVersion.update({
      where: { id },
      data: { status: 'published', publishedAt: new Date() },
      include: { seo: true },
    });
  }

  async unpublish(id: string) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');
    return this.prisma.bookVersion.update({
      where: { id },
      data: { status: 'draft', publishedAt: null },
      include: { seo: true },
    });
  }

  async updateRightsGeoBlock(id: string, dto: UpdateRightsGeoBlockDto) {
    const existing = await this.prisma.bookVersion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('BookVersion not found');

    const updateData: Record<string, unknown> = {
      rightsGeoBlockConfigured: dto.configured,
      rightsGeoBlockNotesRu: dto.notesRu ?? null,
    };

    if (dto.configured) {
      updateData.rightsGeoBlockConfiguredAt = new Date();
    } else {
      updateData.rightsGeoBlockConfiguredAt = null;
    }

    return this.prisma.bookVersion.update({
      where: { id },
      data: updateData,
      include: { seo: true },
    });
  }

  // Админский листинг без фильтра по статусу
  async listAdmin(
    bookId: string,
    filters: { language?: Language; type?: BookType; isFree?: boolean },
  ) {
    const where: Prisma.BookVersionWhereInput = {
      bookId,
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.isFree !== undefined ? { isFree: filters.isFree } : {}),
    };
    return this.prisma.bookVersion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { seo: true },
    });
  }
}
