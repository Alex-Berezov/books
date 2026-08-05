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

  /**
   * @param categoryIds when given, only these terms are touched; otherwise every
   *   translation in the language is recomputed.
   */
  private async syncCategories(
    language: Language,
    categoryIds?: string[],
  ): Promise<{ total: number; changed: number }> {
    if (categoryIds?.length === 0) return { total: 0, changed: 0 };

    const counts = await this.countBooksByCategory(language);
    const translations = await this.prisma.categoryTranslation.findMany({
      where: { language, ...(categoryIds ? { categoryId: { in: categoryIds } } : {}) },
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

  /** @param tagIds — same contract as `syncCategories`. */
  private async syncTags(
    language: Language,
    tagIds?: string[],
  ): Promise<{ total: number; changed: number }> {
    if (tagIds?.length === 0) return { total: 0, changed: 0 };

    const counts = await this.countBooksByTag(language);
    const translations = await this.prisma.tagTranslation.findMany({
      where: { language, ...(tagIds ? { tagId: { in: tagIds } } : {}) },
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
   *
   * @param cold which translation tables to reset to `autoIndexable = false`
   *   *before* recomputing. The hysteresis keeps the previous state in the 3–4
   *   book band, and on a table that has never been computed that "previous
   *   state" is the schema default `true` — an opinion nobody formed. Resetting
   *   first makes the band resolve downwards, so only terms that reach the upper
   *   threshold (>=5) come out indexable. Per table, because the decision is not
   *   the same for categories and tags: a tag is the weakest page type.
   *
   *   Not something to run routinely — it erases real state history and turns
   *   the hysteresis into a plain >=5 threshold for that run.
   */
  async recomputeAll(cold?: { categories?: boolean; tags?: boolean }): Promise<RecomputeResult> {
    const result: RecomputeResult = { categoryTranslations: 0, tagTranslations: 0, changed: 0 };

    if (cold?.categories) {
      const reset = await this.prisma.categoryTranslation.updateMany({
        where: { autoIndexable: true },
        data: { autoIndexable: false },
      });
      this.logger.warn(
        `Cold start: ${reset.count} category translations reset to autoIndexable=false`,
      );
    }
    if (cold?.tags) {
      const reset = await this.prisma.tagTranslation.updateMany({
        where: { autoIndexable: true },
        data: { autoIndexable: false },
      });
      this.logger.warn(`Cold start: ${reset.count} tag translations reset to autoIndexable=false`);
    }

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

      await this.syncCategories(
        version.language,
        categoryLinks.map((link) => link.categoryId),
      );
      await this.syncTags(
        version.language,
        tagLinks.map((link) => link.tagId),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to recompute taxonomy indexability for version ${bookVersionId}: ${String(error)}`,
      );
    }
  }

  /**
   * Recompute an explicit set of terms in **every** language.
   *
   * Attaching or detaching a taxonomy links it to all sibling versions of the
   * book at once, so every language is affected — and on detach the term is no
   * longer reachable from the version, which is why `recomputeForBookVersion`
   * cannot be used for it: it would recompute everything except the term that
   * actually changed.
   *
   * Errors are swallowed for the same reason as above — an SEO counter must
   * never break an editorial action.
   */
  async recomputeForTerms(categoryIds: string[], tagIds: string[]): Promise<void> {
    if (categoryIds.length === 0 && tagIds.length === 0) return;

    try {
      for (const language of Object.values(Language)) {
        if (categoryIds.length > 0) await this.syncCategories(language, categoryIds);
        if (tagIds.length > 0) await this.syncTags(language, tagIds);
      }
    } catch (error) {
      this.logger.warn(`Failed to recompute taxonomy indexability for terms: ${String(error)}`);
    }
  }
}
