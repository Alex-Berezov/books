import { Language, Seo } from '@prisma/client';
import { buildTermBundle, TermBundleInput, PublicTermPageType } from './buildTermBundle';

/**
 * `LEGACY-317`. Пока сборщик лежал приватным методом сервиса на 1300 строк,
 * проверить его можно было только через `resolvePublic` — то есть подняв моки
 * Prisma для каждого типа термина. Из-за этого `seo.service.spec.ts` завёл
 * `seedTerm()`/`seedMissing()` с развилкой `if (termType === 'tag')` по двум
 * Prisma-моделям: развилку по модели, которую из самого сборщика как раз
 * убирали, вернули в тесты.
 *
 * Здесь база не нужна вовсе: функция принимает готовые значения.
 */
describe('buildTermBundle', () => {
  const input = (over: Partial<TermBundleInput> = {}): TermBundleInput => ({
    pageType: 'genre',
    effLang: Language.en,
    slug: 'the-term',
    name: 'The Term',
    metaTitle: 'The Term | Bibliaris',
    metaDescription: 'Description',
    canonicalUrl: 'https://site/en/genre/the-term',
    robots: 'index, follow',
    seo: null,
    slugsMap: { en: 'the-term', ru: 'termin' },
    trail: [],
    ...over,
  });

  const TYPES: PublicTermPageType[] = ['category', 'genre', 'collection', 'tag'];

  it.each(TYPES)(
    'тип %s доходит до канонического адреса и hreflang, а не подменяется литералом',
    (pageType) => {
      const bundle = buildTermBundle(
        input({ pageType, canonicalUrl: `https://site/en/${pageType}/the-term` }),
      ) as {
        hreflangs: Array<{ href: string }>;
        schema: { '@graph': Array<{ url?: string }> };
      };

      // ⚠️ Ровно эта подмена дала `LEGACY-273`: в ветку жанра руками вписали
      // литерал `'collection'`, и адрес уехал в чужой раздел.
      expect(bundle.hreflangs.every((link) => link.href.includes(`/${pageType}/`))).toBe(true);
      expect(bundle.hreflangs.length).toBeGreaterThan(0);
    },
  );

  it('канонический адрес один и тот же в meta, openGraph и первом узле @graph', () => {
    const bundle = buildTermBundle(input()) as {
      meta: { canonicalUrl: string };
      openGraph: { url: string };
      schema: { '@graph': Array<{ '@id'?: string }> };
    };

    expect(bundle.openGraph.url).toBe(bundle.meta.canonicalUrl);
    expect(bundle.schema['@graph'][0]['@id']).toBe(`${bundle.meta.canonicalUrl}#webpage`);
  });

  it('breadcrumbPath — это trail без главной и без самого термина', () => {
    const bundle = buildTermBundle(
      input({
        trail: [{ name: 'Collections', url: 'https://site/en/collections' }],
      }),
    ) as { breadcrumbPath: Array<{ name: string; slug: string }> };

    expect(bundle.breadcrumbPath).toEqual([{ name: 'Collections', slug: 'collections' }]);
  });

  // У тега предков не бывает, и пустой список говорит это явно. Проверка стоит
  // отдельно от предыдущей: она про контракт, а не про преобразование.
  it('пустой trail даёт пустой breadcrumbPath, а не отсутствующее поле', () => {
    const bundle = buildTermBundle(input({ pageType: 'tag', trail: [] }));

    expect(bundle).toHaveProperty('breadcrumbPath');
    expect(bundle.breadcrumbPath).toEqual([]);
  });

  it('крошки в @graph начинаются с главной на языке страницы', () => {
    const bundle = buildTermBundle(input({ effLang: Language.ru })) as {
      schema: { '@graph': Array<{ itemListElement?: Array<{ name: string }> }> };
    };

    const crumbs = bundle.schema['@graph']
      .map((node) => node.itemListElement)
      .find((items): items is Array<{ name: string }> => Array.isArray(items));

    expect(crumbs?.[0]?.name).toBe('Главная');
  });

  it('robots и описание проходят насквозь, а запись SEO перебивает Open Graph', () => {
    const bundle = buildTermBundle(
      input({
        robots: 'noindex, follow',
        seo: { id: 1, ogTitle: 'Manual' } as Seo,
      }),
    ) as { meta: { robots: string; description?: string }; openGraph: { title: string } };

    expect(bundle.meta.robots).toBe('noindex, follow');
    expect(bundle.meta.description).toBe('Description');
    expect(bundle.openGraph.title).toBe('Manual');
  });

  it('набор полей верхнего уровня закреплён: страница термина отдаёт все шесть', () => {
    expect(Object.keys(buildTermBundle(input())).sort()).toEqual(
      ['meta', 'openGraph', 'twitter', 'schema', 'hreflangs', 'breadcrumbPath'].sort(),
    );
  });
});
