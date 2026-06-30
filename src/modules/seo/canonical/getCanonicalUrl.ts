import { buildAbsoluteUrl } from '../utils/buildAbsoluteUrl';
import { normalizeUrl } from './normalizeUrl';

export function getCanonicalUrl(
  type: 'book' | 'version' | 'page' | 'author' | 'genre' | 'category' | 'tag' | 'static',
  slug: string,
  locale?: string,
): string {
  let path = '';
  const lang = locale ? locale.toLowerCase() : '';

  switch (type) {
    case 'book':
      path = lang ? `/${lang}/book/${slug}` : `/book/${slug}`;
      break;
    case 'version':
      path = `/versions/${slug}`;
      break;
    case 'page':
      path = lang ? `/${lang}/pages/${slug}` : `/pages/${slug}`;
      break;
    case 'author':
      path = lang ? `/${lang}/author/${slug}` : `/author/${slug}`;
      break;
    case 'genre':
      path = lang ? `/${lang}/genre/${slug}` : `/genre/${slug}`;
      break;
    case 'category':
      path = lang ? `/${lang}/category/${slug}` : `/category/${slug}`;
      break;
    case 'tag':
      path = lang ? `/${lang}/tag/${slug}` : `/tag/${slug}`;
      break;
    case 'static':
      path = lang ? `/${lang}/${slug}` : `/${slug}`;
      break;
    default:
      path = `/${slug}`;
  }

  return normalizeUrl(buildAbsoluteUrl(path));
}
