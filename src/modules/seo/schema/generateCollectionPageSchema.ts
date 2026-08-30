import { getCanonicalUrl, CanonicalPathType } from '../canonical/getCanonicalUrl';

export interface CollectionItem {
  name: string;
  url: string;
}

/**
 * `LEGACY-319`. Здесь словари ручки и адресов стыкуются, и стык один на весь модуль:
 * `catalog` - тип страницы, который принимает `/seo/resolve`, но которого нет
 * в `CanonicalPathType`. Отображение `catalog -> static` ниже сделано руками
 * намеренно и «упрощению» не подлежит: добавить `catalog` в словарь адресов -
 * значит сменить канонический адрес страницы каталога.
 */
export type CollectionPageType =
  | Extract<CanonicalPathType, 'category' | 'tag' | 'genre' | 'collection'>
  | 'catalog';

export function generateCollectionPageSchema(
  type: CollectionPageType,
  slug: string,
  language: string,
  name: string,
  description: string,
  items: CollectionItem[],
): Record<string, unknown> {
  const canonicalUrl = getCanonicalUrl(type === 'catalog' ? 'static' : type, slug, language);
  return {
    '@type': 'CollectionPage',
    '@id': `${canonicalUrl}#collection`,
    url: canonicalUrl,
    name: name,
    description: description,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: item.url,
        name: item.name,
      })),
    },
  };
}
