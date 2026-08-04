import { Injectable, Logger } from '@nestjs/common';
import { Language, PublicationStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { resolveAutoIndexable } from './taxonomyIndexability';

export interface RecomputeResult {
  categoryTranslations: number;
  tagTranslations: number;
  changed: number;
}

/**
 * Keeps `bookCount` / `autoIndexable` on taxonomy translations in sync with the
 * number of published books, applying the hysteresis from taxonomyIndexability.ts.
 *
 * The state is stored, not computed per request, so that the sitemap filter and
 * the robots meta tag can never disagree.
 */
@Injectable()
export class TaxonomyIndexabilityService {
  private readonly logger = new Logger(TaxonomyIndexabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Published book versions per category, for one language. */
  private async countBooksByCategory(language: Language): Promise<Map<string, number>> {
    const rows = await this.prisma.bookCategory.groupBy({
      by: ['categoryId'],
      where: { bookVersion: { status: PublicationStatus.published, language } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.categoryId, row._count._all]));
  }

  /** Published book versions per tag, for one language. */
  private async countBooksByTag(language: Language): Promise<Map<string, number>> {
    const rows = await this.prisma.bookTag.groupBy({
      by: ['tagId'],
      where: { bookVersion: { status: PublicationStatus.published, language } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.tagId, row._count._all]));
  }

  private async syncCategories(language: Language): Promise<{ total: number; changed: number }> {
    const counts = await this.countBooksByCategory(language);
    const translations = await this.prisma.categoryTranslation.findMany({
      where: { language },
      select: { id: true, categoryId: true, bookCount: true, autoIndexable: true },
    });

    let changed = 0;
    for (const translation of translations) {
      const bookCount = counts.get(translation.categoryId) ?? 0;
      const autoIndexable = resolveAutoIndexable(bookCount, translation.autoIndexable);
      if (bookCount === translation.bookCount && autoIndexable === translation.autoIndexable) {
        continue;
      }
      await this.prisma.categoryTranslation.update({
        where: { id: translation.id },
        data: { bookCount, autoIndexable },
      });
      changed += 1;
    }

    return { total: translations.length, changed };
  }

  private async syncTags(language: Language): Promise<{ total: number; changed: number }> {
    const counts = await this.countBooksByTag(language);
    const translations = await this.prisma.tagTranslation.findMany({
      where: { language },
      select: { id: true, tagId: true, bookCount: true, autoIndexable: true },
    });

    let changed = 0;
    for (const translation of translations) {
      const bookCount = counts.get(translation.tagId) ?? 0;
      const autoIndexable = resolveAutoIndexable(bookCount, translation.autoIndexable);
      if (bookCount === translation.bookCount && autoIndexable === translation.autoIndexable) {
        continue;
      }
      await this.prisma.tagTranslation.update({
        where: { id: translation.id },
        data: { bookCount, autoIndexable },
      });
      changed += 1;
    }

    return { total: translations.length, changed };
  }

  /**
   * Recompute every taxonomy translation. Safe to call repeatedly — it only
   * writes rows whose count or state actually changed.
   */
  async recomputeAll(): Promise<RecomputeResult> {
    const result: RecomputeResult = { categoryTranslations: 0, tagTranslations: 0, changed: 0 };

    for (const language of Object.values(Language)) {
      const categories = await this.syncCategories(language);
      const tags = await this.syncTags(language);
      result.categoryTranslations += categories.total;
      result.tagTranslations += tags.total;
      result.changed += categories.changed + tags.changed;
    }

    this.logger.log(
      `Taxonomy indexability recomputed: ${result.categoryTranslations} category + ` +
        `${result.tagTranslations} tag translations, ${result.changed} updated`,
    );
    return result;
  }

  /**
   * Recompute only the terms attached to one book version — the cheap path used
   * after publish/unpublish. Errors are swallowed: an SEO counter must never
   * break a publishing action.
   */
  async recomputeForBookVersion(bookVersionId: string): Promise<void> {
    try {
      const version = await this.prisma.bookVersion.findUnique({
        where: { id: bookVersionId },
        select: { language: true },
      });
      if (!version) return;

      const [categoryLinks, tagLinks] = await Promise.all([
        this.prisma.bookCategory.findMany({
          where: { bookVersionId },
          select: { categoryId: true },
        }),
        this.prisma.bookTag.findMany({ where: { bookVersionId }, select: { tagId: true } }),
      ]);

      const language = version.language;
      const categoryIds = categoryLinks.map((link) => link.categoryId);
      const tagIds = tagLinks.map((link) => link.tagId);

      if (categoryIds.length > 0) {
        const counts = await this.countBooksByCategory(language);
        const translations = await this.prisma.categoryTranslation.findMany({
          where: { language, categoryId: { in: categoryIds } },
          select: { id: true, categoryId: true, bookCount: true, autoIndexable: true },
        });
        for (const translation of translations) {
          const bookCount = counts.get(translation.categoryId) ?? 0;
          const autoIndexable = resolveAutoIndexable(bookCount, translation.autoIndexable);
          if (bookCount === translation.bookCount && autoIndexable === translation.autoIndexable) {
            continue;
          }
          await this.prisma.categoryTranslation.update({
            where: { id: translation.id },
            data: { bookCount, autoIndexable },
          });
        }
      }

      if (tagIds.length > 0) {
        const counts = await this.countBooksByTag(language);
        const translations = await this.prisma.tagTranslation.findMany({
          where: { language, tagId: { in: tagIds } },
          select: { id: true, tagId: true, bookCount: true, autoIndexable: true },
        });
        for (const translation of translations) {
          const bookCount = counts.get(translation.tagId) ?? 0;
          const autoIndexable = resolveAutoIndexable(bookCount, translation.autoIndexable);
          if (bookCount === translation.bookCount && autoIndexable === translation.autoIndexable) {
            continue;
          }
          await this.prisma.tagTranslation.update({
            where: { id: translation.id },
            data: { bookCount, autoIndexable },
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to recompute taxonomy indexability for version ${bookVersionId}: ${String(error)}`,
      );
    }
  }
}
