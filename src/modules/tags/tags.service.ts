import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Language, Tag, TagTranslation, BookVersion } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { resolveRequestedLanguage } from '../../shared/language/language.util';
import { CreateTagTranslationDto } from './dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from './dto/update-tag-translation.dto';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  async list(page = 1, limit = 20, search?: string) {
    const skip = (page - 1) * limit;
    const where: Prisma.TagWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
            { translations: { some: { name: { contains: search, mode: 'insensitive' } } } },
          ],
        }
      : {};

    const [total, items] = await this.prisma.$transaction([
      this.prisma.tag.count({ where }),
      this.prisma.tag.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
        include: {
          translations: {
            select: {
              language: true,
              name: true,
              slug: true,
              description: true,
              relatedTagSlugs: true,
              relatedGenreSlugs: true,
              relatedCategorySlugs: true,
              relatedCollectionSlugs: true,
            },
          },
        },
      }),
    ]);

    // Count distinct books per tag (via bookId, not BookVersion)
    const tagIds = items.map((item) => item.id);
    const bookCounts =
      tagIds.length > 0
        ? await this.prisma.$queryRaw<Array<{ tagId: string; booksCount: number }>>`
          SELECT bt."tagId", COUNT(DISTINCT bv."bookId")::int as "booksCount"
          FROM "BookTag" bt
          JOIN "BookVersion" bv ON bt."bookVersionId" = bv.id
          WHERE bt."tagId" IN (${Prisma.join(tagIds)})
            AND bv.status = 'published'
          GROUP BY bt."tagId"
        `
        : [];
    const countMap = new Map(bookCounts.map((row) => [row.tagId, row.booksCount]));

    const data = items.map((item) => ({
      id: item.id,
      name: item.name,
      slug: item.slug,
      key: item.key,
      indexable: item.indexable ?? true,
      isVisible: item.isVisible ?? true,
      sortOrder: item.sortOrder ?? 0,
      translations: item.translations,
      booksCount: countMap.get(item.id) || 0,
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(dto: CreateTagDto) {
    return this.prisma.tag.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        key: dto.key || dto.slug,
        ...(dto.indexable !== undefined ? { indexable: dto.indexable } : {}),
        ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async update(id: string, dto: UpdateTagDto) {
    const exists = await this.prisma.tag.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Tag not found');
    return this.prisma.tag.update({
      where: { id },
      data: {
        name: dto.name,
        slug: dto.slug,
        ...(dto.key !== undefined
          ? { key: dto.key }
          : dto.slug !== undefined
            ? { key: dto.slug }
            : {}),
        ...(dto.indexable !== undefined ? { indexable: dto.indexable } : {}),
        ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async remove(id: string) {
    const exists = await this.prisma.tag.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Tag not found');

    // Detach from books
    await this.prisma.bookTag.deleteMany({ where: { tagId: id } });

    // Delete translations
    await this.prisma.tagTranslation.deleteMany({ where: { tagId: id } });

    return this.prisma.tag.delete({ where: { id } });
  }

  async versionsByTagSlug(
    slug: string,
    queryLang?: string,
    acceptLanguageHeader?: string,
  ): Promise<{
    tag: Tag & { translation: TagTranslation | null; description: string | null };
    seo: Record<string, unknown> | null;
    versions: BookVersion[];
    availableLanguages: Language[];
  }> {
    const headerLang = acceptLanguageHeader || null;
    const preferred = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: headerLang,
      available: [],
    });
    const trans = await this.prisma.tagTranslation.findUnique({
      where: { language_slug: { language: preferred ?? Language.en, slug } },
      include: { tag: true, seo: true },
    });
    let tagId: string | null = null;
    let baseTag: Tag | null = null;
    if (trans?.tag && trans.tag.isVisible !== false) {
      tagId = trans.tag.id;
      baseTag = trans.tag;
    }
    if (!tagId) {
      // Fallback to base Tag by slug for backward compatibility
      const found = await this.prisma.tag.findFirst({
        where: { slug, isVisible: true },
      });
      if (!found) throw new NotFoundException('Tag not found');
      tagId = found.id;
      baseTag = found;
    }
    // public only: published versions with this tag
    const versions = await this.prisma.bookVersion.findMany({
      where: { status: 'published', tags: { some: { tagId } } },
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });
    const availableLanguages: Language[] = Array.from(new Set(versions.map((v) => v.language)));
    const effective = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: headerLang,
      available: availableLanguages,
    });
    const filtered = effective ? versions.filter((v) => v.language === effective) : versions;
    return {
      tag: {
        id: baseTag!.id,
        name: baseTag!.name,
        slug: baseTag!.slug,
        key: baseTag!.key,
        indexable: baseTag!.indexable,
        isVisible: baseTag!.isVisible,
        sortOrder: baseTag!.sortOrder,
        translation: (trans as TagTranslation) ?? null,
        description: trans?.description ?? null,
      } as Tag & { translation: TagTranslation | null; description: string | null },
      seo: trans?.seo ?? null,
      versions: filtered,
      availableLanguages,
    };
  }

  async versionsByTagLangSlug(
    pathLang: Language,
    slug: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    tag: Tag & { translation: TagTranslation | null; description: string | null };
    seo: Record<string, unknown> | null;
    data: BookVersion[];
    meta: { page: number; limit: number; total: number; totalPages: number };
    availableLanguages: Language[];
  }> {
    const trans = await this.prisma.tagTranslation.findUnique({
      where: { language_slug: { language: pathLang, slug } },
      include: { tag: true, seo: true },
    });
    let tagId: string | null = null;
    let baseTag: Tag | null = null;
    if (trans?.tag && trans.tag.isVisible !== false) {
      baseTag = trans.tag;
      tagId = trans.tag.id;
    } else {
      // Fallback to base Tag by slug for backward compatibility
      const found = await this.prisma.tag.findFirst({
        where: { slug, isVisible: true },
      });
      if (!found) throw new NotFoundException('Tag not found');
      tagId = found.id;
      baseTag = found;
    }
    const where = {
      status: 'published' as const,
      language: pathLang,
      tags: { some: { tagId } },
    };
    const [versions, total] = await Promise.all([
      this.prisma.bookVersion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { seo: { select: { metaTitle: true, metaDescription: true } } },
      }),
      this.prisma.bookVersion.count({ where }),
    ]);
    const availableLanguages: Language[] = Array.from(
      new Set(
        (
          await this.prisma.bookVersion.findMany({
            where: { status: 'published', tags: { some: { tagId } } },
            select: { language: true },
          })
        ).map((v) => v.language),
      ),
    );
    return {
      tag: {
        ...baseTag,
        translation: (trans as TagTranslation) ?? null,
        description: trans?.description ?? null,
      },
      seo: trans?.seo ?? null,
      data: versions,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      availableLanguages,
    };
  }

  // ===== Translations (Admin) =====
  listTranslations(tagId: string): Promise<any[]> {
    return this.prisma.tagTranslation.findMany({
      where: { tagId },
      orderBy: { language: 'asc' },
      include: { seo: true },
    });
  }

  async createTranslation(tagId: string, dto: CreateTagTranslationDto) {
    const exists = await this.prisma.tag.findUnique({ where: { id: tagId } });
    if (!exists) throw new NotFoundException('Tag not found');

    let seoId: number | undefined;
    if (dto.seo) {
      const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
      if (hasSeoData) {
        const newSeo = await this.prisma.seo.create({ data: dto.seo });
        seoId = newSeo.id;
      }
    }

    try {
      return await this.prisma.tagTranslation.create({
        data: {
          tagId,
          language: dto.language,
          name: dto.name,
          slug: dto.slug,
          description: dto.description ?? null,
          ...(dto.relatedTagSlugs !== undefined ? { relatedTagSlugs: dto.relatedTagSlugs } : {}),
          ...(dto.relatedGenreSlugs !== undefined
            ? { relatedGenreSlugs: dto.relatedGenreSlugs }
            : {}),
          ...(dto.relatedCategorySlugs !== undefined
            ? { relatedCategorySlugs: dto.relatedCategorySlugs }
            : {}),
          ...(dto.relatedCollectionSlugs !== undefined
            ? { relatedCollectionSlugs: dto.relatedCollectionSlugs }
            : {}),
          ...(seoId !== undefined ? { seoId } : {}),
        },
        include: { seo: true },
      });
    } catch (e: any) {
      if (seoId) {
        await this.prisma.seo.delete({ where: { id: seoId } }).catch(() => {});
      }
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Translation with same (language, slug) already exists');
      }
      throw e;
    }
  }

  async updateTranslation(tagId: string, language: Language, dto: UpdateTagTranslationDto) {
    const tr = await this.prisma.tagTranslation.findUnique({
      where: { tagId_language: { tagId, language } },
    });
    if (!tr) throw new NotFoundException('Translation not found');

    if (dto.slug) {
      const dup = await this.prisma.tagTranslation.findFirst({
        where: { language, slug: dto.slug, NOT: { id: tr.id } },
      });
      if (dup)
        throw new BadRequestException('Translation with same (language, slug) already exists');
    }

    let finalSeoId: number | null | undefined = undefined;
    if (dto.seo) {
      const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
      if (hasSeoData) {
        if (tr.seoId) {
          await this.prisma.seo.update({ where: { id: tr.seoId }, data: dto.seo });
          finalSeoId = tr.seoId;
        } else {
          const newSeo = await this.prisma.seo.create({ data: dto.seo });
          finalSeoId = newSeo.id;
        }
      } else if (tr.seoId) {
        finalSeoId = null;
        await this.prisma.seo.delete({ where: { id: tr.seoId } });
      }
    }

    return this.prisma.tagTranslation.update({
      where: { tagId_language: { tagId, language } },
      data: {
        name: dto.name,
        slug: dto.slug,
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.relatedTagSlugs !== undefined ? { relatedTagSlugs: dto.relatedTagSlugs } : {}),
        ...(dto.relatedGenreSlugs !== undefined
          ? { relatedGenreSlugs: dto.relatedGenreSlugs }
          : {}),
        ...(dto.relatedCategorySlugs !== undefined
          ? { relatedCategorySlugs: dto.relatedCategorySlugs }
          : {}),
        ...(dto.relatedCollectionSlugs !== undefined
          ? { relatedCollectionSlugs: dto.relatedCollectionSlugs }
          : {}),
        ...(finalSeoId !== undefined ? { seoId: finalSeoId } : {}),
      },
      include: { seo: true },
    });
  }

  async deleteTranslation(tagId: string, language: Language) {
    const tr = await this.prisma.tagTranslation.findUnique({
      where: { tagId_language: { tagId, language } },
    });
    if (!tr) return { success: true };

    await this.prisma.$transaction(async (tx) => {
      await tx.tagTranslation.delete({
        where: { tagId_language: { tagId, language } },
      });
      if (tr.seoId) {
        await tx.seo.delete({ where: { id: tr.seoId } });
      }
    });

    return { success: true };
  }

  async attach(versionId: string, tagId: string) {
    const [version, tag] = await Promise.all([
      this.prisma.bookVersion.findUnique({
        where: { id: versionId },
        select: { id: true, bookId: true },
      }),
      this.prisma.tag.findUnique({ where: { id: tagId } }),
    ]);
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!tag) throw new NotFoundException('Tag not found');

    const siblings = await this.prisma.bookVersion.findMany({
      where: { bookId: version.bookId },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      for (const sibling of siblings) {
        const exists = await tx.bookTag.findFirst({
          where: { bookVersionId: sibling.id, tagId },
          select: { id: true },
        });
        if (!exists) {
          await tx.bookTag.create({ data: { bookVersionId: sibling.id, tagId } });
        }
      }
    });

    return this.prisma.bookTag.findFirst({
      where: { bookVersionId: versionId, tagId },
    });
  }

  async detach(versionId: string, tagId: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { bookId: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    const siblings = await this.prisma.bookVersion.findMany({
      where: { bookId: version.bookId },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      for (const sibling of siblings) {
        const link = await tx.bookTag.findFirst({
          where: { bookVersionId: sibling.id, tagId },
        });
        if (link) {
          await tx.bookTag.delete({ where: { id: link.id } });
        }
      }
    });

    return { success: true };
  }
}
