import { Language } from '@prisma/client';

/**
 * Локализованные названия разделов сайта для хлебных крошек.
 *
 * 🔴 `LEGACY-317`. До 30.08.2026 их держали три разных места и тремя разными
 * способами: `getHomeName` — приватный метод с `switch` и веткой `default`,
 * ветка `catalog` резолвера — вложенные тернарники на пять языков, а
 * `TAXONOMY_PAGES.collection.section.names` — обычный объект. Ни `switch`
 * с `default`, ни лесенка тернарников не краснеют, когда в `Language`
 * добавляется язык: оба молча отдают английскую строку.
 *
 * ⚠️ Тип `Record<Language, string>` выбран ровно за это: пропущенный язык —
 * ошибка сборки, а не молчаливый фолбэк на английский. Ветка «язык неизвестен»
 * не нужна вовсе: сюда приходит уже разобранный `Language`, а не строка
 * запроса.
 */
const HOME_NAMES: Record<Language, string> = {
  en: 'Home',
  ru: 'Главная',
  es: 'Inicio',
  pt: 'Início',
  fr: 'Accueil',
};

/**
 * Раздел «Подборки» над термином-коллекцией в хлебных крошках. Лежит здесь,
 * а не в `TAXONOMY_PAGES`, по той же причине, что и два словаря выше: место
 * для локализованного ярлыка раздела должно быть одно, иначе следующий такой
 * ярлык ляжет в то из двух, которое автор найдёт первым, — а до 30.08.2026
 * их и было три.
 */
export const COLLECTIONS_NAMES: Record<Language, string> = {
  en: 'Collections',
  es: 'Colecciones',
  fr: 'Collections',
  pt: 'Coleções',
  ru: 'Подборки',
};

const CATALOG_NAMES: Record<Language, string> = {
  en: 'Catalog',
  ru: 'Каталог',
  es: 'Catálogo',
  pt: 'Catálogo',
  fr: 'Catalogue',
};

export const getHomeName = (lang: Language): string => HOME_NAMES[lang];

export const getCatalogName = (lang: Language): string => CATALOG_NAMES[lang];
