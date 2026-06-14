import { getCanonicalUrl } from '../canonical/getCanonicalUrl';

export interface BookSchemaData {
  slug: string;
  title: string;
  authorName: string;
  authorSlug?: string;
  language: string;
  genres: string[];
  datePublished?: string | null;
  coverImageUrl?: string | null;
  description?: string | null;
  textAvailable?: boolean;
  audioAvailable?: boolean;
  ratingAverage?: number | null;
  ratingCount?: number;
}

export function generateBookSchema(data: BookSchemaData): Record<string, unknown> {
  const canonicalUrl = getCanonicalUrl('book', data.slug, data.language);
  const authorCanonical = data.authorSlug
    ? getCanonicalUrl('author', data.authorSlug, data.language)
    : undefined;

  const schema: Record<string, unknown> = {
    '@type': 'Book',
    '@id': `${canonicalUrl}#book`,
    name: data.title,
    inLanguage: data.language.toLowerCase(),
    url: canonicalUrl,
    isAccessibleForFree: true,
  };

  if (data.authorName) {
    const authorObj: Record<string, unknown> = {
      '@type': 'Person',
      name: data.authorName,
    };
    if (authorCanonical) {
      authorObj['@id'] = `${authorCanonical}#person`;
      authorObj.url = authorCanonical;
    }
    schema.author = authorObj;
  }

  if (data.genres && data.genres.length > 0) {
    schema.genre = data.genres;
  }

  if (data.datePublished) {
    schema.datePublished = String(data.datePublished);
  }

  if (data.coverImageUrl) {
    schema.image = data.coverImageUrl;
  }

  if (data.description) {
    schema.description = data.description;
  }

  const potentialAction: Record<string, unknown>[] = [];
  if (data.textAvailable) {
    potentialAction.push({
      '@type': 'ReadAction',
      target: `${canonicalUrl}/read`,
    });
  }
  if (data.audioAvailable) {
    potentialAction.push({
      '@type': 'ListenAction',
      target: `${canonicalUrl}/listen`,
    });
  }
  if (potentialAction.length > 0) {
    schema.potentialAction = potentialAction;
  }

  if (data.ratingCount && data.ratingCount >= 3 && data.ratingAverage != null) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: String(data.ratingAverage),
      ratingCount: String(data.ratingCount),
      bestRating: '5',
      worstRating: '1',
    };
  }

  return schema;
}
