import { getCanonicalUrl } from '../canonical/getCanonicalUrl';

export interface AuthorSchemaData {
  slug: string;
  name: string;
  biography?: string | null;
  language: string;
}

export function generateAuthorSchema(data: AuthorSchemaData) {
  const canonicalUrl = getCanonicalUrl('author', data.slug, data.language);
  const schema: Record<string, unknown> = {
    '@type': 'Person',
    '@id': `${canonicalUrl}#person`,
    name: data.name,
    url: canonicalUrl,
  };

  if (data.biography) {
    schema.description = data.biography;
  }

  return schema;
}
