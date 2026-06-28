import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Prisma, Category as PrismaCategory, Language } from '@prisma/client';
import { resolveRequestedLanguage } from '../../shared/language/language.util';
import { CreateCategoryTranslationDto } from './dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from './dto/update-category-translation.dto';

export type CategoryTreeNode = {
  id: string;
  name: string;
  slug: string;
  type: PrismaCategory['type'];
  parentId: string | null;
  booksCount: number;
  children: CategoryTreeNode[];
};

@Injectable()
export class CategoryService {
  constructor(private prisma: PrismaService) {}

  async list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.category.count(),
      this.prisma.category.findMany({
        orderBy: { name: 'asc' },
        skip,
        take: limit,
        include: {
          translations: {
            select: {
              language: true,
              name: true,
              slug: true,
            },
          },
          _count: {
            select: { books: true },
          },
        },
      }),
    ]);

    const data = items.map((item) => ({
      id: item.id,
      name: item.name,
      slug: item.slug,
      type: item.type,
      booksCount: item._count.books,
      translations: item.translations,
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

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new BadRequestException('Parent category not found');
    }
    try {
      return await this.prisma.category.create({
        data: {
          type: dto.type,
          name: dto.name,
          slug: dto.slug,
          ...(dto.parentId ? { parent: { connect: { id: dto.parentId } } } : {}),
        },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Category with same slug already exists');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');
    if (dto.slug) {
      const dup = await this.prisma.category.findFirst({ where: { slug: dto.slug, NOT: { id } } });
      if (dup) throw new BadRequestException('Category with same slug already exists');
    }
    // parent validations
    if (typeof dto.parentId !== 'undefined') {
      if (dto.parentId === id) {
        throw new BadRequestException('Category cannot be parent of itself');
      }
      if (dto.parentId) {
        const parent = await this.prisma.category.findUnique({ where: { id: dto.parentId } });
        if (!parent) throw new BadRequestException('Parent category not found');
        // check cycle: parent cannot be a descendant of current node
        const hasCycle = await this.isDescendant(dto.parentId, id);
        if (hasCycle) throw new BadRequestException('Cycle detected in category hierarchy');
      }
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        type: dto.type,
        name: dto.name,
        slug: dto.slug,
        ...(typeof dto.parentId === 'undefined'
          ? {}
          : dto.parentId
            ? { parent: { connect: { id: dto.parentId } } }
            : { parent: { disconnect: true } }),
      },
    });
  }

  async remove(id: string) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');
    const childrenCount = await this.prisma.category.count({ where: { parent: { id } } });
    if (childrenCount > 0) {
      throw new BadRequestException('Cannot delete category with children');
    }
    // Detach all books first
    await this.prisma.bookCategory.deleteMany({ where: { categoryId: id } });

    // Delete translations
    await this.prisma.categoryTranslation.deleteMany({ where: { categoryId: id } });

    return this.prisma.category.delete({ where: { id } });
  }

  async getBySlugWithBooks(slug: string, queryLang?: string, acceptLanguageHeader?: string) {
    const headerLang = acceptLanguageHeader || null;
    const preferred = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: headerLang,
      available: [],
    });

    const trans = await this.prisma.categoryTranslation.findUnique({
      where: { language_slug: { language: preferred ?? Language.en, slug } },
      include: { category: true, seo: true },
    });
    let category: PrismaCategory | null =
      trans && 'category' in trans ? ((trans.category as PrismaCategory | null) ?? null) : null;
    if (!category) {
      // Fallback to base category by slug for backward compatibility
      category = await this.prisma.category.findFirst({ where: { slug } });
      if (!category) throw new NotFoundException('Category not found');
    }

    // Public endpoint: only published versions
    const books = await this.prisma.book.findMany({
      where: {
        versions: {
          some: {
            status: 'published',
            categories: { some: { categoryId: category.id } },
          },
        },
      },
      include: {
        versions: {
          include: {
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
      orderBy: { createdAt: 'desc' },
    });

    const allVersions = books.flatMap((b) => b.versions);
    const availableLanguages: Language[] = Array.from(new Set(allVersions.map((v) => v.language)));
    const effective = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: acceptLanguageHeader || null,
      available: availableLanguages,
    });

    const filteredBooks = effective
      ? books.filter((b) => b.versions.some((v) => v.language === effective))
      : books;

    return {
      category: {
        ...category,
        translation: trans ?? null,
        description: trans?.description ?? null,
      },
      seo: trans?.seo ?? null,
      data: filteredBooks,
      total: filteredBooks.length,
      page: 1,
      limit: 100,
      totalPages: 1,
      availableLanguages,
    };
  }

  // Public resolver by path language and translation slug (/:lang/categories/:slug/books)
  async getByLangSlugWithBooks(pathLang: Language, slug: string) {
    let trans = await this.prisma.categoryTranslation.findUnique({
      where: { language_slug: { language: pathLang, slug } },
      include: { category: true, seo: true },
    });
    let category: PrismaCategory | null =
      trans && 'category' in trans ? ((trans.category as PrismaCategory | null) ?? null) : null;
    if (!category) {
      // Fallback to base category by slug OR id if slug is a UUID
      category = await this.prisma.category.findFirst({
        where: {
          OR: [
            { slug },
            ...(slug.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
              ? [{ id: slug }]
              : []),
          ],
        },
      });
      if (!category) throw new NotFoundException('Category not found');

      // Fetch the translation using the category ID we just resolved
      trans = await this.prisma.categoryTranslation.findFirst({
        where: { categoryId: category.id, language: pathLang },
        include: { category: true, seo: true },
      });
    }

    const books = await this.prisma.book.findMany({
      where: {
        versions: {
          some: {
            status: 'published',
            language: pathLang,
            categories: { some: { categoryId: category.id } },
          },
        },
      },
      include: {
        versions: {
          include: {
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
      orderBy: { createdAt: 'desc' },
    });

    const availableLanguages: Language[] = Array.from(
      new Set(
        (
          await this.prisma.bookVersion.findMany({
            where: { status: 'published', categories: { some: { categoryId: category.id } } },
            select: { language: true },
          })
        ).map((v) => v.language),
      ),
    );

    return {
      category: {
        ...category,
        translation: trans ? { ...trans, category: undefined } : null,
        description: trans?.description ?? null,
        language: pathLang,
      },
      seo: trans?.seo ?? null,
      data: books,
      total: books.length,
      page: 1,
      limit: 100,
      totalPages: 1,
      availableLanguages,
    };
  }

  // ===== Translations (Admin) =====
  listTranslations(categoryId: string) {
    return this.prisma.categoryTranslation.findMany({
      where: { categoryId },
      orderBy: { language: 'asc' },
      include: { seo: true },
    });
  }

  async createTranslation(categoryId: string, dto: CreateCategoryTranslationDto) {
    const exists = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!exists) throw new NotFoundException('Category not found');

    let seoId: number | undefined;
    if (dto.seo) {
      const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
      if (hasSeoData) {
        const newSeo = await this.prisma.seo.create({ data: dto.seo });
        seoId = newSeo.id;
      }
    }

    try {
      return await this.prisma.categoryTranslation.create({
        data: {
          categoryId,
          language: dto.language,
          name: dto.name,
          slug: dto.slug,
          description: dto.description ?? null,
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

  async updateTranslation(
    categoryId: string,
    language: Language,
    dto: UpdateCategoryTranslationDto,
  ) {
    const tr = await this.prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId, language } },
    });
    if (!tr) throw new NotFoundException('Translation not found');

    if (dto.slug) {
      const dup = await this.prisma.categoryTranslation.findFirst({
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

    return this.prisma.categoryTranslation.update({
      where: { categoryId_language: { categoryId, language } },
      data: {
        name: dto.name,
        slug: dto.slug,
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(finalSeoId !== undefined ? { seoId: finalSeoId } : {}),
      },
      include: { seo: true },
    });
  }

  async deleteTranslation(categoryId: string, language: Language) {
    const tr = await this.prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId, language } },
    });
    if (!tr) return { success: true };

    await this.prisma.$transaction(async (tx) => {
      await tx.categoryTranslation.delete({
        where: { categoryId_language: { categoryId, language } },
      });
      if (tr.seoId) {
        await tx.seo.delete({ where: { id: tr.seoId } });
      }
    });

    return { success: true };
  }

  async attachCategoryToVersion(versionId: string, categoryId: string) {
    const [version, category] = await Promise.all([
      this.prisma.bookVersion.findUnique({ where: { id: versionId } }),
      this.prisma.category.findUnique({ where: { id: categoryId } }),
    ]);
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!category) throw new NotFoundException('Category not found');

    const exists = await this.prisma.bookCategory.findFirst({
      where: { bookVersionId: versionId, categoryId },
      select: { id: true },
    });
    if (exists) return exists; // idempotent

    try {
      return await this.prisma.bookCategory.create({
        data: { bookVersionId: versionId, categoryId },
      });
    } catch (e: any) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // unique(bookVersionId, categoryId)
        return this.prisma.bookCategory.findFirst({
          where: { bookVersionId: versionId, categoryId },
        });
      }
      throw e;
    }
  }

  async detachCategoryFromVersion(versionId: string, categoryId: string) {
    const link = await this.prisma.bookCategory.findFirst({
      where: { bookVersionId: versionId, categoryId },
    });
    if (!link) throw new NotFoundException('Relation not found');
    await this.prisma.bookCategory.delete({ where: { id: link.id } });
    return { success: true };
  }

  // ===== Hierarchy helpers =====
  async getTree(): Promise<CategoryTreeNode[]> {
    type CategoryNode = CategoryTreeNode;
    type CategoryWithCount = {
      id: string;
      name: string;
      slug: string;
      type: PrismaCategory['type'];
      parentId: string | null;
      _count: { books: number };
    };
    const all: CategoryWithCount[] = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        parentId: true,
        _count: { select: { books: true } },
      },
    });
    const byId = new Map<string, CategoryNode>(
      all.map((c) => [
        c.id,
        {
          id: c.id,
          name: c.name,
          slug: c.slug,
          type: c.type,
          parentId: c.parentId,
          booksCount: c._count.books,
          children: [],
        } as CategoryNode,
      ]),
    );
    const roots: CategoryNode[] = [];
    for (const c of byId.values()) {
      if (c.parentId && byId.has(c.parentId)) {
        byId.get(c.parentId)!.children.push(c);
      } else {
        roots.push(c);
      }
    }
    return roots;
  }

  async getChildren(id: string) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');
    return this.prisma.category.findMany({ where: { parent: { id } }, orderBy: { name: 'asc' } });
  }

  async getAncestors(id: string) {
    const node = await this.prisma.category.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (!node) throw new NotFoundException('Category not found');
    const path: Array<{
      id: string;
      name: string;
      slug: string;
      type: PrismaCategory['type'];
      parentId: string | null;
    }> = [];
    let current: string | null = node.parentId;
    while (current) {
      const c = await this.prisma.category.findUnique({
        where: { id: current },
        select: { id: true, name: true, slug: true, type: true, parentId: true },
      });
      if (!c) break;
      path.push(c);
      current = c.parentId;
    }
    // we collected from child->parent, need root->... order excluding the node itself
    return path.reverse();
  }

  private async isDescendant(nodeId: string, maybeAncestorId: string): Promise<boolean> {
    // climb up from nodeId to root to see if we meet maybeAncestorId
    let current: string | null = nodeId;
    while (current) {
      const c: { parentId: string | null } | null = await this.prisma.category.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      if (!c) return false;
      if (c.parentId === maybeAncestorId) return true;
      current = c.parentId;
    }
    return false;
  }

  async checkSlugExists(slug: string, excludeId?: string) {
    const where: Prisma.CategoryWhereInput = { slug };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    return this.prisma.category.findFirst({
      where,
      select: { id: true, name: true, slug: true },
    });
  }

  async generateUniqueSuggestedSlug(baseSlug: string): Promise<string> {
    let counter = 1;
    let candidate = baseSlug;

    // Check if base slug exists
    let exists = await this.prisma.category.findFirst({ where: { slug: candidate } });

    while (exists) {
      counter++;
      candidate = `${baseSlug}-${counter}`;
      exists = await this.prisma.category.findFirst({ where: { slug: candidate } });
    }

    return candidate;
  }
}
