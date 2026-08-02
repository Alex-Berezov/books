/**
 * WP-F.1: вывод провайдера и внешнего ID источника из ссылки.
 *
 * Это **вывод приложения**, а не факт, установленный человеком: он заполняет только пробелы
 * интейка и уходит агенту с признаком `derivedFromUrl`. Сетевых запросов здесь нет и быть
 * не должно — разбирается только строка адреса.
 */
export interface DerivedSourceFromUrl {
  provider: 'PROJECT_GUTENBERG';
  externalId: string | null;
}

const GUTENBERG_HOST = /(^|\.)gutenberg\.org$/i;

/** `/ebooks/932`, `/files/932/932-0.txt`, `/cache/epub/932/pg932.txt`, `/etext/932`. */
const GUTENBERG_ID_PATTERNS: readonly RegExp[] = [
  /\/ebooks\/(\d+)/i,
  /\/files\/(\d+)/i,
  /\/cache\/epub\/(\d+)/i,
  /\/etext\/(\d+)/i,
];

export function deriveSourceFromUrl(url: unknown): DerivedSourceFromUrl | null {
  if (typeof url !== 'string' || url.trim() === '') {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (!GUTENBERG_HOST.test(parsed.hostname)) {
    return null;
  }

  for (const pattern of GUTENBERG_ID_PATTERNS) {
    const match = pattern.exec(parsed.pathname);
    if (match) {
      return { provider: 'PROJECT_GUTENBERG', externalId: match[1] };
    }
  }

  return { provider: 'PROJECT_GUTENBERG', externalId: null };
}

/**
 * Тип текста выводится только когда язык источника совпадает с языком оригинала: иначе перед
 * нами перевод или неизвестно что, и молчаливый `ORIGINAL_TEXT` был бы утверждением о правах.
 */
export function isSameLanguage(sourceLanguage: unknown, originalLanguage: unknown): boolean {
  if (typeof sourceLanguage !== 'string' || typeof originalLanguage !== 'string') {
    return false;
  }
  const source = sourceLanguage.trim().toLowerCase();
  const original = originalLanguage.trim().toLowerCase();
  return source !== '' && source === original;
}
