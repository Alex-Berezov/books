import { buildAbsoluteUrl } from '../utils/buildAbsoluteUrl';
import { normalizeUrl } from './normalizeUrl';

/**
 * Вид пути, который умеет собрать канонический адрес.
 *
 * `LEGACY-319`. Это **не** тип запроса `/seo/resolve` и не подмножество его типа:
 * два словаря пересекаются, но ни один не вложен в другой. Здесь есть `author`
 * и `static`, которых ручка не принимает вовсе; у ручки есть `catalog`, которого
 * нет здесь. Мост между ними ровно один и он явный -
 * `generateCollectionPageSchema` отображает `catalog` в `static`.
 *
 * 🔴 Добавление `catalog` сюда сменило бы канонический адрес страницы каталога -
 * это тема владельца, а не правка типов. Решение арбитра от 30.08.2026,
 * строка в `decisions-log.md`.
 *
 * Кому нужно подмножество - берёт его `Exclude`/`Extract` от этого типа,
 * а не выписывает литералы заново.
 */
export type CanonicalPathType =
  | 'book'
  | 'version'
  | 'page'
  | 'author'
  | 'genre'
  | 'category'
  | 'collection'
  | 'tag'
  | 'static';

export function getCanonicalUrl(type: CanonicalPathType, slug: string, locale?: string): string {
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
    case 'collection':
      path = lang ? `/${lang}/collection/${slug}` : `/collection/${slug}`;
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
