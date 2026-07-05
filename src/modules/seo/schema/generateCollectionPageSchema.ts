import { getCanonicalUrl } from '../canonical/getCanonicalUrl';

export interface CollectionItem {
  name: string;
  url: string;
}

export function generateCollectionPageSchema(
  type: 'category' | 'tag' | 'genre' | 'catalog' | 'collection',
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
