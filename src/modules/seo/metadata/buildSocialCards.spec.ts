import { Seo } from '@prisma/client';
import { buildSocialCards } from './buildSocialCards';

/**
 * `LEGACY-317`. Раньше эти правила стояли в `seo.service.ts` четырьмя дословными
 * копиями и не были покрыты ничем, кроме проверок отдельных веток резолвера:
 * юнит на одну ветку зеленеет на разошедшихся копиях по определению.
 */
describe('buildSocialCards', () => {
  const seoRow = (over: Partial<Seo>): Seo => ({ id: 1, ...over }) as Seo;

  const base = {
    seo: null,
    metaTitle: 'Title',
    metaDescription: 'Description',
    canonicalUrl: 'https://site/en/book/slug',
    ogType: 'website' as const,
  };

  it('без записи SEO и без обложки картинки нет, а карточка маленькая', () => {
    const { openGraph, twitter } = buildSocialCards(base);

    expect(openGraph).toEqual({
      title: 'Title',
      description: 'Description',
      type: 'website',
      url: 'https://site/en/book/slug',
      image: undefined,
    });
    expect(twitter).toEqual({
      card: 'summary',
      site: undefined,
      creator: undefined,
      image: undefined,
    });
  });

  // ⚠️ Ровно это правило и разъезжалось между копиями: карточка становится
  // большой от наличия картинки, а не от типа страницы.
  it('обложка делает карточку большой и подставляет заголовок в alt', () => {
    const { openGraph, twitter } = buildSocialCards({
      ...base,
      ogType: 'book',
      coverImageUrl: 'https://img/cover.jpg',
    });

    expect(openGraph.type).toBe('book');
    expect(openGraph.image).toEqual({ url: 'https://img/cover.jpg', alt: 'Title' });
    expect(twitter.card).toBe('summary_large_image');
    expect(twitter.image).toBe('https://img/cover.jpg');
  });

  it('картинка из записи SEO перебивает обложку, alt берётся оттуда же', () => {
    const { openGraph, twitter } = buildSocialCards({
      ...base,
      coverImageUrl: 'https://img/cover.jpg',
      seo: seoRow({ ogImageUrl: 'https://img/manual.jpg', ogImageAlt: 'Manual alt' }),
    });

    expect(openGraph.image).toEqual({ url: 'https://img/manual.jpg', alt: 'Manual alt' });
    expect(twitter.image).toBe('https://img/manual.jpg');
  });

  it('заголовок, описание и адрес из записи SEO перебивают выведенные', () => {
    const { openGraph } = buildSocialCards({
      ...base,
      seo: seoRow({
        ogTitle: 'Manual title',
        ogDescription: 'Manual description',
        ogUrl: 'https://site/manual',
      }),
    });

    expect(openGraph).toMatchObject({
      title: 'Manual title',
      description: 'Manual description',
      url: 'https://site/manual',
    });
  });

  // Тип карточки задан руками — картинки нет, но и `summary` навязывать нельзя.
  it('twitterCard из записи SEO перебивает правило про картинку', () => {
    const { twitter } = buildSocialCards({
      ...base,
      seo: seoRow({ twitterCard: 'summary_large_image', twitterSite: '@s', twitterCreator: '@c' }),
    });

    expect(twitter).toEqual({
      card: 'summary_large_image',
      site: '@s',
      creator: '@c',
      image: undefined,
    });
  });

  // Пустая строка в базе — не значение: колонки nullable, но приходят и `''`.
  it('пустые строки записи SEO не считаются заданными значениями', () => {
    const { openGraph, twitter } = buildSocialCards({
      ...base,
      coverImageUrl: 'https://img/cover.jpg',
      seo: seoRow({ ogTitle: '', ogImageUrl: '', twitterCard: '' }),
    });

    expect(openGraph.title).toBe('Title');
    expect(openGraph.image).toEqual({ url: 'https://img/cover.jpg', alt: 'Title' });
    expect(twitter.card).toBe('summary_large_image');
  });
});
