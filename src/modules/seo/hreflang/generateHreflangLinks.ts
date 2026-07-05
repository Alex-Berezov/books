import { getCanonicalUrl } from '../canonical/getCanonicalUrl';

export interface HreflangLink {
  rel: 'alternate';
  hreflang: string;
  href: string;
}

export function generateHreflangLinks(
  type: 'book' | 'page' | 'author' | 'genre' | 'category' | 'collection' | 'tag' | 'static',
  slugs: Record<string, string>,
): HreflangLink[] {
  const links: HreflangLink[] = [];
  const languages = Object.keys(slugs);

  for (const lang of languages) {
    const slug = slugs[lang];
    if (slug) {
      links.push({
        rel: 'alternate',
        hreflang: lang.toLowerCase(),
        href: getCanonicalUrl(type, slug, lang),
      });
    }
  }

  // Add x-default pointing to English if available, or the first available language
  const defaultLang = slugs['en'] ? 'en' : slugs['EN'] ? 'EN' : languages[0];
  if (defaultLang && slugs[defaultLang]) {
    links.push({
      rel: 'alternate',
      hreflang: 'x-default',
      href: getCanonicalUrl(type, slugs[defaultLang], defaultLang),
    });
  }

  return links;
}
