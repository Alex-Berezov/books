import { Injectable } from '@nestjs/common';
import { CategoryType, Language } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Термин, на который ссылается страница тега, со всем, что нужно для решения
 * «ставить ли ссылку».
 *
 * 🔴 Здесь только **факты**, без вердикта. Предикат «линкуем ли термин» живёт на
 * фронте (`isTaxonomyLinkable`) и обязан остаться в одном экземпляре: вторая
 * копия правила на бэкенде разошлась бы с первой — ровно тот класс дефектов,
 * из-за которого ссылка, sitemap и robots уже расходились по одному термину.
 */
export interface RelatedTerm {
  slug: string;
  name: string;
  isVisible: boolean;
  indexable: boolean;
  autoIndexable: boolean;
  langBookCount: number;
}

export interface RelatedTerms {
  tags: RelatedTerm[];
  genres: RelatedTerm[];
  categories: RelatedTerm[];
  collections: RelatedTerm[];
}

/**
 * Формы строк объявлены явно, а не выведены из Prisma: ветка «пустой список»
 * возвращает `[]`, и без аннотации союз с выведенным типом схлопывался в `any` —
 * то есть проверка типов на самом горячем месте молча исчезала.
 */
type TagRow = {
  slug: string;
  name: string;
  bookCount: number;
  autoIndexable: boolean;
  tag: { isVisible: boolean; indexable: boolean };
};

type CategoryRow = {
  slug: string;
  name: string;
  bookCount: number;
  autoIndexable: boolean;
  category: { isVisible: boolean; indexable: boolean; type: CategoryType };
};

export interface RelatedSlugInput {
  tags: string[];
  genres: string[];
  categories: string[];
  collections: string[];
}

/**
 * Разрешает `related*Slugs` перевода тега в настоящие термины.
 *
 * 🔴 Зачем. Четыре массива слагов из `TagTranslation` рендерились напрямую:
 * существование термина не проверялось, видимость и индексируемость тоже, а
 * текстом ссылки шёл сырой слаг. Замер на проде 09.08.2026 по языку `en`:
 *
 * | Ссылок | Ведут куда |
 * | --- | --- |
 * | 1039 | всего |
 * | 303 | на существующий и открытый термин |
 * | 622 | на существующий, но закрытый (`noindex`) |
 * | 114 | на термин, которого нет (56 уникальных → 404, 8 → 308 по истории слагов) |
 *
 * То есть ~71 % внутренних ссылок с тегов были либо битыми, либо нарушали
 * инвариант «ссылка = sitemap = robots».
 *
 * ⚠️ Несуществующий слаг просто **не попадает** в ответ. Отдавать его с пометкой
 * «не найден» значило бы предлагать фронту решать, что с ним делать, — а решать
 * тут нечего: термина нет, ссылки быть не может.
 */
@Injectable()
export class RelatedTaxonomyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Пустой список в базу не идёт: резолвер вызывается на каждой странице тега. */
  private loadTagTerms(language: Language, slugs: string[]): Promise<TagRow[]> {
    if (slugs.length === 0) return Promise.resolve([]);
    return this.prisma.tagTranslation.findMany({
      where: { language, slug: { in: slugs } },
      select: {
        slug: true,
        name: true,
        bookCount: true,
        autoIndexable: true,
        tag: { select: { isVisible: true, indexable: true } },
      },
    });
  }

  private loadCategoryTerms(language: Language, slugs: string[]): Promise<CategoryRow[]> {
    if (slugs.length === 0) return Promise.resolve([]);
    return this.prisma.categoryTranslation.findMany({
      where: { language, slug: { in: slugs } },
      select: {
        slug: true,
        name: true,
        bookCount: true,
        autoIndexable: true,
        category: { select: { isVisible: true, indexable: true, type: true } },
      },
    });
  }

  async resolve(language: Language, input: RelatedSlugInput): Promise<RelatedTerms> {
    const categorySlugs = [...input.genres, ...input.categories, ...input.collections];

    // Два запроса на всю страницу независимо от числа слагов: на теге их бывает
    // под десяток, и запрос на каждый превратил бы страницу в N обращений к базе.
    const [tagRows, categoryRows] = await Promise.all([
      this.loadTagTerms(language, input.tags),
      this.loadCategoryTerms(language, categorySlugs),
    ]);

    const tagBySlug = new Map(
      tagRows.map((r): [string, RelatedTerm] => [
        r.slug,
        {
          slug: r.slug,
          name: r.name,
          isVisible: r.tag.isVisible,
          indexable: r.tag.indexable,
          autoIndexable: r.autoIndexable,
          langBookCount: r.bookCount,
        } satisfies RelatedTerm,
      ]),
    );

    // ⚠️ Тип сверяется, а не берётся на веру: слаги категорий, жанров и коллекций
    // живут в одной таблице и в одном пространстве имён. Слаг жанра, записанный
    // в `relatedCategorySlugs`, дал бы ссылку `/en/category/...` на термин,
    // который на самом деле жанр, — то есть живой 404 вместо битой ссылки.
    const categoryBySlug = new Map(
      categoryRows.map((r): [string, { type: CategoryType; term: RelatedTerm }] => [
        r.slug,
        {
          type: r.category.type,
          term: {
            slug: r.slug,
            name: r.name,
            isVisible: r.category.isVisible,
            indexable: r.category.indexable,
            autoIndexable: r.autoIndexable,
            langBookCount: r.bookCount,
          } satisfies RelatedTerm,
        },
      ]),
    );

    const pickCategories = (slugs: string[], type: CategoryType): RelatedTerm[] =>
      slugs
        .map((slug) => categoryBySlug.get(slug))
        .filter((row): row is NonNullable<typeof row> => Boolean(row) && row?.type === type)
        .map((row) => row.term);

    return {
      // Порядок сохраняется тот, в котором слаги записал редактор: это его
      // приоритет, и пересортировка выдачи молча его потеряла бы.
      tags: input.tags
        .map((slug) => tagBySlug.get(slug))
        .filter((t): t is RelatedTerm => Boolean(t)),
      genres: pickCategories(input.genres, 'genre'),
      categories: pickCategories(input.categories, 'category'),
      collections: pickCategories(input.collections, 'collection'),
    };
  }
}
