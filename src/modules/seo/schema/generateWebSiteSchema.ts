import { buildAbsoluteUrl } from '../utils/buildAbsoluteUrl';

export function generateWebSiteSchema(language: string = 'en'): Record<string, unknown> {
  const base = buildAbsoluteUrl('/');
  const lang = language.toLowerCase();
  return {
    '@type': 'WebSite',
    '@id': `${base}#website`,
    url: base,
    name: 'Bibliaris',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${base}${lang}/search?query={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}
