import { Language, Seo } from '@prisma/client';
import { buildAbsoluteUrl } from '../utils/buildAbsoluteUrl';
import { getHomeName } from '../utils/sectionNames';
import { getCanonicalUrl } from '../canonical/getCanonicalUrl';
import { generateHreflangLinks } from '../hreflang/generateHreflangLinks';
import { generateBreadcrumbSchema } from './generateBreadcrumbSchema';
import { generateCollectionPageSchema } from './generateCollectionPageSchema';
import { generateWebSiteSchema } from './generateWebSiteSchema';
import { buildSocialCards } from '../metadata/buildSocialCards';
import { TaxonomyPageType } from '../seo.types';

/**
 * 🔴 `LEGACY-316`. Типы страниц, чей публичный ответ собирает `buildTermBundle`.
 * Шире `TaxonomyPageType` ровно на тег: он живёт отдельной моделью и в `CategoryType`
 * не входит, но страница у него та же по составу.
 */
export type PublicTermPageType = TaxonomyPageType | 'tag';

/**
 * Готовые значения, из которых `buildTermBundle` собирает публичный ответ
 * страницы термина. Тип именованный, а не встроенный в сигнатуру: имена полей тогда
 * живут в одном месте, а не в трёх, и добавленное поле нельзя забыть разобрать.
 */
export interface TermBundleInput {
  pageType: PublicTermPageType;
  effLang: Language;
  slug: string;
  name: string;
  metaTitle: string;
  metaDescription?: string;
  canonicalUrl: string;
  robots: string;
  seo: Seo | null;
  /** Слаг перевода по коду языка в нижнем регистре — для hreflang. */
  slugsMap: Record<string, string>;
  /** Крошки **между** главной и самим термином. У тега всегда пусто. */
  trail: Array<{ name: string; url: string }>;
}

/**
 * 🔴 `LEGACY-316`. Сборка публичного ответа страницы термина — одна на все
 * четыре типа, у которых она есть: `category`, `genre`, `collection` и `tag`.
 *
 * `LEGACY-309` свела три ветки из четырёх; ветка `tag` осталась четвёртой копией
 * и уже разошлась с остальными — не отдавала `breadcrumbPath` и писала своё имя
 * типа тремя отдельными литералами. Ровно тот же приём породил `LEGACY-273`:
 * литерал берётся из допустимого union, и ни компилятор, ни линт подмены не видят.
 *
 * ⚠️ Функция принимает **готовые значения** и ничего не читает из базы. «Где взять
 * перевод», «как посчитать индексируемость» и «есть ли у типа предки» остаются
 * у вызывающих: у тега своя модель и три флага индексируемости вместо двух
 * (`TagTranslation.indexable` существует, у `CategoryTranslation` его нет вовсе),
 * а дерева у него нет. Втащить это внутрь значило бы вернуть развилку по модели
 * в общий метод.
 *
 * ⚠️ Тип страницы — обычный строковый параметр, а не `CategoryType`: тег в этот
 * Prisma-энум не входит. Поэтому `TAXONOMY_PAGES` остаётся `Record<CategoryType, ...>`
 * и сохраняет свою компиляторную гарантию, а текст 404 и раздел в крошках тег
 * держит у себя. Решение арбитра от 29.08.2026, строка в `decisions-log.md`.
 *
 * @param trail крошки **между** главной и самим термином. У тега всегда пусто.
 */
export function buildTermBundle({
  pageType,
  effLang,
  slug,
  name,
  metaTitle,
  metaDescription,
  canonicalUrl,
  robots,
  seo,
  slugsMap,
  trail,
}: TermBundleInput): Record<string, unknown> {
  const { openGraph, twitter } = buildSocialCards({
    seo,
    metaTitle,
    metaDescription,
    canonicalUrl,
    ogType: 'website',
  });

  const breadcrumbItems = [
    { name: getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
    ...trail,
    { name, url: canonicalUrl },
  ];
  const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
  const collectionSchema = generateCollectionPageSchema(
    pageType,
    slug,
    effLang,
    name,
    metaDescription || '',
    [],
  );

  return {
    meta: {
      title: metaTitle,
      description: metaDescription,
      robots,
      canonicalUrl,
    },
    openGraph,
    twitter,
    schema: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          '@id': `${canonicalUrl}#webpage`,
          url: canonicalUrl,
          name: metaTitle,
          description: metaDescription,
          inLanguage: effLang.toLowerCase(),
          isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
          breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
        },
        generateWebSiteSchema(effLang),
        breadcrumbSchema,
        collectionSchema,
      ],
    },
    hreflangs: generateHreflangLinks(pageType, slugsMap),
    // Крошки без главной и без самого термина — ровно то, что раньше собиралось
    // здесь как `breadcrumbItems.slice(1, -1)`. У тега список всегда пуст:
    // предков у него не бывает, и пустой массив говорит это явно, а не молчанием.
    breadcrumbPath: trail.map((item) => ({
      name: item.name,
      slug: item.url.split('/').pop() || '',
    })),
  };
}
