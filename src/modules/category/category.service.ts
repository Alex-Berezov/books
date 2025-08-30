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
  children: CategoryTreeNode[];
};

@Injectable()
export class CategoryService {
  constructor(private prisma: PrismaService) {}

  list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    return this.prisma.category.findMany({ orderBy: { name: 'asc' }, skip, take: limit });
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
      include: { category: true },
    });
    let category: PrismaCategory | null =
      trans && 'category' in trans ? ((trans.category as PrismaCategory | null) ?? null) : null;
    if (!category) {
      // Fallback to base category by slug for backward compatibility
      category = await this.prisma.category.findFirst({ where: { slug } });
      if (!category) throw new NotFoundException('Category not found');
    }

    // Public endpoint: only published versions
    const versions = await this.prisma.bookVersion.findMany({
      where: {
        status: 'published',
        categories: { some: { categoryId: category.id } },
      },
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
    });

    const availableLanguages: Language[] = Array.from(new Set(versions.map((v) => v.language)));
    const effective = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: acceptLanguageHeader || null,
      available: availableLanguages,
    });
    const filtered = effective ? versions.filter((v) => v.language === effective) : versions;

    return {
      category: { ...category, translation: trans ?? null },
      versions: filtered,
      availableLanguages,
    };
  }

  // Public resolver by path language and translation slug (/:lang/categories/:slug/books)
  async getByLangSlugWithBooks(pathLang: Language, slug: string) {
    const trans = await this.prisma.categoryTranslation.findUnique({
      where: { language_slug: { language: pathLang, slug } },
      include: { category: true },
    });
    let category: PrismaCategory | null =
      trans && 'category' in trans ? ((trans.category as PrismaCategory | null) ?? null) : null;
    if (!category) {
      // Fallback to base category by slug if translation not present
      category = await this.prisma.category.findFirst({ where: { slug } });
      if (!category) throw new NotFoundException('Category not found');
    }

    const versions = await this.prisma.bookVersion.findMany({
      where: {
        status: 'published',
        language: pathLang,
        categories: { some: { categoryId: category.id } },
      },
      orderBy: { createdAt: 'desc' },
      include: { seo: { select: { metaTitle: true, metaDescription: true } } },
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

    return { category: { ...category, translation: trans ?? null }, versions, availableLanguages };
  }

  // ===== Translations (Admin) =====
  listTranslations(categoryId: string) {
    return this.prisma.categoryTranslation.findMany({
      where: { categoryId },
      orderBy: { language: 'asc' },
    });
  }

  async createTranslation(categoryId: string, dto: CreateCategoryTranslationDto) {
    const exists = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!exists) throw new NotFoundException('Category not found');
    try {
      return this.prisma.categoryTranslation.create({
        data: { categoryId, language: dto.language, name: dto.name, slug: dto.slug },
      });
    } catch (e: any) {
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

    return this.prisma.categoryTranslation.update({
      where: { categoryId_language: { categoryId, language } },
      data: { name: dto.name, slug: dto.slug },
    });
  }

  async deleteTranslation(categoryId: string, language: Language) {
    const tr = await this.prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId, language } },
    });
    if (!tr) return { success: true };
    await this.prisma.categoryTranslation.delete({
      where: { categoryId_language: { categoryId, language } },
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
    const all: Array<Omit<CategoryNode, 'children'>> = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, type: true, parentId: true },
    });
    const byId = new Map<string, CategoryNode>(
      all.map((c) => [c.id, { ...c, children: [] } as CategoryNode]),
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
}
