import { Injectable } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportCategoryDto } from './dto/import-category.dto';
import { ImportTagDto } from './dto/import-tag.dto';
import { SLUG_REGEX } from '../../shared/validators/slug';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';

const SUPPORTED_LANGS = new Set(Object.values(Language));

/**
 * Клиент транзакции или обычный. Методы записи принимают его параметром, а не
 * ходят в `this.prisma`: оставленный на `this.prisma` вызов внутри
 * `$transaction` уходит на другое соединение и вместе с транзакцией уже не
 * откатывается (`LEGACY-131`).
 */
type PrismaLike = Prisma.TransactionClient | PrismaService;

interface TranslationInput {
  name: string;
  slug: string;
  description?: string | null;
  h1?: string;
  shortDescription?: string | null;
  metaTitle?: string;
  metaDescription?: string | null;
  ogTitle?: string;
  ogDescription?: string | null;
  ogImageUrl?: string | null;
  ogImageAlt?: string;
  canonicalUrl?: string;
  robots?: string;
  indexable?: boolean;
  faq?: Array<{ question: string; answer: string }>;
  relatedTagSlugs?: string[];
  relatedGenreSlugs?: string[];
  relatedCategorySlugs?: string[];
  relatedCollectionSlugs?: string[];
}

export interface ImportResult {
  imported: number;
  updated: number;
  errors: Array<{ key: string; message: string }>;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class ImportService {
  constructor(
    private prisma: PrismaService,
    private slugRedirects: SlugRedirectService,
  ) {}

  async importCategories(items: ImportCategoryDto[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };

    for (const item of items) {
      const langError = this.validateTranslations(item.translations);
      if (langError) {
        result.errors.push({ key: item.key, message: langError });
      }
    }

    const validItems = items.filter((item) => !result.errors.find((e) => e.key === item.key));

    const allKeys = new Set(validItems.map((i) => i.key));
    for (const item of validItems) {
      if (item.parentKey && !allKeys.has(item.parentKey)) {
        const exists = await this.prisma.category.findUnique({
          where: { key: item.parentKey },
          select: { id: true },
        });
        if (!exists) {
          result.errors.push({
            key: item.key,
            message: `parentKey "${item.parentKey}" not found in database or current batch`,
          });
        }
      }
    }

    const batch = validItems.filter((item) => !result.errors.find((e) => e.key === item.key));

    for (const item of batch) {
      try {
        const wasExisting = await this.prisma.category.findUnique({
          where: { key: item.key },
          select: { id: true },
        });
        await this.upsertCategory(item);
        if (wasExisting) {
          result.updated++;
        } else {
          result.imported++;
        }
      } catch (err: unknown) {
        const prismaErr = err as Prisma.PrismaClientKnownRequestError;
        if (prismaErr.code === 'P2002') {
          result.errors.push({
            key: item.key,
            message: `Duplicate key "${item.key}" or slug conflict`,
          });
        } else {
          result.errors.push({ key: item.key, message: getErrorMessage(err) });
        }
      }
    }

    return result;
  }

  async importTags(items: ImportTagDto[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };

    for (const item of items) {
      const langError = this.validateTranslations(item.translations);
      if (langError) {
        result.errors.push({ key: item.key, message: langError });
        continue;
      }

      try {
        const wasExisting = await this.prisma.tag.findUnique({
          where: { key: item.key },
          select: { id: true },
        });
        await this.upsertTag(item);
        if (wasExisting) {
          result.updated++;
        } else {
          result.imported++;
        }
      } catch (err: unknown) {
        const prismaErr = err as Prisma.PrismaClientKnownRequestError;
        if (prismaErr.code === 'P2002') {
          result.errors.push({
            key: item.key,
            message: `Duplicate key "${item.key}" or slug conflict`,
          });
        } else {
          result.errors.push({ key: item.key, message: getErrorMessage(err) });
        }
      }
    }

    return result;
  }

  private validateTranslations(translations: Record<string, TranslationInput>): string | null {
    const langs = Object.keys(translations);
    if (langs.length === 0) return 'At least one translation required';
    for (const lang of langs) {
      if (!SUPPORTED_LANGS.has(lang as Language)) {
        return `Unsupported language "${lang}". Supported: ${Object.values(Language).join(', ')}`;
      }
      const tr = translations[lang] as TranslationInput | undefined;
      if (!tr || typeof tr !== 'object') {
        return `Translation for "${lang}" must be an object`;
      }
      if (!tr.name || typeof tr.name !== 'string' || tr.name.length < 2) {
        return `Translation "${lang}" name: min 2 chars`;
      }
      if (!tr.slug || !SLUG_REGEX.test(tr.slug)) {
        return `Translation "${lang}" slug: invalid kebab-case format`;
      }
    }
    return null;
  }

  private async upsertCategory(dto: ImportCategoryDto) {
    const existing = await this.prisma.category.findUnique({
      where: { key: dto.key },
      include: { translations: true },
    });

    const commonData: Prisma.CategoryCreateInput = {
      type: dto.type,
      name: this.getFirstName(dto.translations),
      slug: this.getFirstSlug(dto.translations),
      key: dto.key,
      indexable: dto.indexable ?? true,
      isVisible: dto.isVisible ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };

    if (existing) {
      await this.prisma.category.update({
        where: { key: dto.key },
        data: {
          type: dto.type,
          name: this.getFirstName(dto.translations),
          // 🔴 `slug` намеренно НЕ переписывается при повторном импорте.
          //
          // Базовый слаг берётся из `getFirstSlug` — то есть из ПЕРВОГО перевода по
          // порядку ключей JSON. Значит тот же набор данных с переставленными языками
          // переименовывал категорию сам по себе, а с историей слагов (LEGACY-062)
          // это порождало бы ещё и 308 на переименования, которых никто не делал.
          // Публичный адрес не может зависеть от форматирования файла импорта.
          // При создании (ветка ниже) слаг по-прежнему выводится оттуда же — там
          // выбирать не из чего, и прежнего адреса не существует.
          indexable: dto.indexable ?? existing.indexable,
          isVisible: dto.isVisible ?? existing.isVisible,
          sortOrder: dto.sortOrder ?? existing.sortOrder,
        },
      });

      if (dto.parentKey !== undefined) {
        await this.updateParentId(this.prisma, 'category', dto.key, dto.parentKey ?? null);
      }

      for (const [langCode, tr] of Object.entries(dto.translations)) {
        const language = langCode as Language;
        const existingTr = existing.translations.find((t) => t.language === language);
        if (existingTr) {
          // Импорт — такой же путь смены слага, как форма в админке, и до 09.08.2026
          // он шёл в обход истории: класс считался закрытым для категорий и тегов,
          // хотя закрыт был только через сервисы (LEGACY-062).
          await this.prisma.$transaction(async (tx) => {
            if (tr.slug && existingTr.slug !== tr.slug) {
              await this.slugRedirects.record(
                { entityType: 'category', language, oldSlug: existingTr.slug, newSlug: tr.slug },
                tx,
              );
            }
            await tx.categoryTranslation.update({
              where: { categoryId_language: { categoryId: existing.id, language } },
              data: {
                name: tr.name,
                slug: tr.slug,
                ...this.buildCategoryTranslationData(tr),
              },
            });
          });
        } else {
          await this.createCategoryTranslation(this.prisma, existing.id, language, tr);
        }
      }
    } else {
      // Термин и его переводы — одна запись (`LEGACY-131`). Обрыв между ними
      // оставляет категорию, которая занимает `slug` и `key` и попадает в дерево,
      // но не показывается ни на одной языковой версии сайта: публичные маршруты
      // отбирают по `CategoryTranslation` нужного языка.
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.category.create({
          data: commonData,
        });

        if (dto.parentKey) {
          await this.updateParentId(tx, 'category', dto.key, dto.parentKey);
        }

        for (const [langCode, tr] of Object.entries(dto.translations)) {
          await this.createCategoryTranslation(tx, created.id, langCode as Language, tr);
        }
      });
    }
  }

  private async createCategoryTranslation(
    db: PrismaLike,
    categoryId: string,
    language: Language,
    tr: TranslationInput,
  ) {
    const data = this.buildCategoryTranslationData(tr);
    return db.categoryTranslation.create({
      data: {
        categoryId,
        language,
        name: tr.name,
        slug: tr.slug,
        // Imported terms arrive empty too — see CategoryService.createTranslation.
        bookCount: 0,
        autoIndexable: false,
        ...data,
      },
    });
  }

  private buildCategoryTranslationData(tr: TranslationInput): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of [
      'description',
      'h1',
      'shortDescription',
      'metaTitle',
      'metaDescription',
      'ogTitle',
      'ogDescription',
      'ogImageUrl',
      'ogImageAlt',
    ] as const) {
      if (tr[field] !== undefined) {
        result[field] = tr[field] ?? null;
      }
    }
    if (tr.faq !== undefined) {
      result.faq = tr.faq ?? null;
    }
    return result;
  }

  private async upsertTag(dto: ImportTagDto) {
    const existing = await this.prisma.tag.findUnique({
      where: { key: dto.key },
      include: { translations: true },
    });

    if (existing) {
      // Базовый слаг тега приходит явным полем `dto.slug`, а не выводится из порядка
      // переводов, — поэтому здесь его смена настоящая, и её можно записывать.
      await this.prisma.$transaction(async (tx) => {
        if (dto.slug && existing.slug !== dto.slug) {
          await this.slugRedirects.recordBaseSlugChange('tag', existing.slug, dto.slug, tx);
        }
        await tx.tag.update({
          where: { key: dto.key },
          data: {
            name: dto.name,
            slug: dto.slug,
            indexable: dto.indexable ?? existing.indexable,
            isVisible: dto.isVisible ?? existing.isVisible,
            sortOrder: dto.sortOrder ?? existing.sortOrder,
          },
        });
      });

      for (const [langCode, tr] of Object.entries(dto.translations)) {
        const language = langCode as Language;
        const existingTr = existing.translations.find((t) => t.language === language);
        if (existingTr) {
          await this.prisma.$transaction(async (tx) => {
            if (tr.slug && existingTr.slug !== tr.slug) {
              await this.slugRedirects.record(
                { entityType: 'tag', language, oldSlug: existingTr.slug, newSlug: tr.slug },
                tx,
              );
            }
            await tx.tagTranslation.update({
              where: { tagId_language: { tagId: existing.id, language } },
              data: {
                name: tr.name,
                slug: tr.slug,
                ...this.buildTagTranslationData(tr),
              },
            });
          });
        } else {
          await this.createTagTranslation(this.prisma, existing.id, language, tr);
        }
      }
    } else {
      // Тот же рисунок, что у категорий, и та же причина (`LEGACY-131`): тег без
      // переводов занимает `slug` и `key`, но публичным маршрутам не виден.
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.tag.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            key: dto.key,
            indexable: dto.indexable ?? true,
            isVisible: dto.isVisible ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
        });

        for (const [langCode, tr] of Object.entries(dto.translations)) {
          await this.createTagTranslation(tx, created.id, langCode as Language, tr);
        }
      });
    }
  }

  private async createTagTranslation(
    db: PrismaLike,
    tagId: string,
    language: Language,
    tr: TranslationInput,
  ) {
    const data = this.buildTagTranslationData(tr);
    return db.tagTranslation.create({
      data: {
        tagId,
        language,
        name: tr.name,
        slug: tr.slug,
        // Imported terms arrive empty too — see CategoryService.createTranslation.
        bookCount: 0,
        autoIndexable: false,
        ...data,
      },
    });
  }

  private buildTagTranslationData(tr: TranslationInput): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const scalarFields = [
      'description',
      'h1',
      'shortDescription',
      'metaTitle',
      'metaDescription',
      'ogTitle',
      'ogDescription',
      'ogImageUrl',
      'ogImageAlt',
      'canonicalUrl',
      'robots',
    ] as const;
    for (const field of scalarFields) {
      if (tr[field] !== undefined) {
        result[field] = tr[field] ?? null;
      }
    }
    if (tr.indexable !== undefined) {
      result.indexable = tr.indexable;
    }
    if (tr.faq !== undefined) {
      result.faq = tr.faq ?? null;
    }
    for (const field of [
      'relatedTagSlugs',
      'relatedGenreSlugs',
      'relatedCategorySlugs',
      'relatedCollectionSlugs',
    ] as const) {
      if (tr[field] !== undefined) {
        result[field] = tr[field] ?? null;
      }
    }
    return result;
  }

  private async updateParentId(
    db: PrismaLike,
    entity: 'category',
    key: string,
    parentKey: string | null,
  ) {
    if (parentKey === null) {
      await db.category.update({
        where: { key },
        data: { parentId: null },
      });
    } else {
      const parent = await db.category.findUnique({
        where: { key: parentKey },
        select: { id: true },
      });
      if (parent) {
        await db.category.update({
          where: { key },
          data: { parentId: parent.id },
        });
      }
    }
  }

  private getFirstName(translations: Record<string, TranslationInput>): string {
    const first = Object.values(translations)[0];
    return first?.name ?? '';
  }

  private getFirstSlug(translations: Record<string, TranslationInput>): string {
    const first = Object.values(translations)[0];
    return first?.slug ?? '';
  }
}
