/**
 * WP-F.1 / WP-M.1: вывод источника из ссылки.
 *
 * Это **вывод приложения**, а не факт, установленный человеком: он заполняет только пробелы
 * интейка и уходит агенту с признаком `derivedFromUrl`. Сетевых запросов здесь нет и быть
 * не должно — разбирается только строка адреса.
 *
 * WP-M.1: разбор перестал быть про один Project Gutenberg. Любая рабочая ссылка теперь даёт
 * источник, потому что провайдер `UNKNOWN` и пустой внешний ID — это не «нет данных», а
 * пробел, который редактор вынужден затыкать руками (в бою в поле ID уезжала строка `null`).
 * Новых значений enum'а `RightsSourceProvider` при этом не заводится: миграции у этапа нет,
 * а площадка называется в `providerHint`, который агент видит в манифесте.
 */
export type DerivedSourceKind =
  /** Project Gutenberg: своя обвязка в файлах и своё, американское, заявление о PD. */
  | 'GUTENBERG'
  /** Викитека и родня: текст набран сообществом, у самой расшифровки своя лицензия. */
  | 'COMMUNITY_WIKI'
  /** Цифровая библиотека: у каждой единицы хранения своё заявление о правах. */
  | 'DIGITAL_LIBRARY'
  /** Всё остальное: про площадку неизвестно ничего, и это тоже сведение для агента. */
  | 'UNKNOWN_WEB';

export interface DerivedSourceFromUrl {
  /**
   * Значение enum'а `RightsSourceProvider`. Всё, что не Gutenberg, — `OTHER`: заводить
   * значение enum'а на каждую площадку означало бы миграцию на каждый новый сайт.
   */
  provider: 'PROJECT_GUTENBERG' | 'OTHER';
  externalId: string | null;
  /** Человекочитаемое имя площадки для агента: «Project Gutenberg», «Wikisource (ru)», хост. */
  providerHint: string;
  kind: DerivedSourceKind;
}

const GUTENBERG_HOST = /(^|\.)gutenberg\.org$/i;

/** `/ebooks/932`, `/files/932/932-0.txt`, `/cache/epub/932/pg932.txt`, `/etext/932`. */
const GUTENBERG_ID_PATTERNS: readonly RegExp[] = [
  /\/ebooks\/(\d+)/i,
  /\/files\/(\d+)/i,
  /\/cache\/epub\/(\d+)/i,
  /\/etext\/(\d+)/i,
];

const WIKI_HOST = /(^|\.)(wikisource|wikipedia|wikibooks|wikimedia)\.org$/i;
const ARCHIVE_HOST = /(^|\.)archive\.org$/i;
const STANDARD_EBOOKS_HOST = /(^|\.)standardebooks\.org$/i;
const HATHITRUST_HOST = /(^|\.)hathitrust\.org$/i;

/** `/wiki/<заголовок>` у любого проекта Викимедиа. */
const WIKI_TITLE_PATTERN = /\/wiki\/(.+)$/i;
/** `/details/<идентификатор>` у Internet Archive. */
const ARCHIVE_ID_PATTERN = /\/details\/([^/]+)/i;
/** `/ebooks/<автор>/<произведение>` у Standard Ebooks. */
const STANDARD_EBOOKS_ID_PATTERN = /\/ebooks\/(.+?)\/?$/i;

function parseHttpUrl(url: unknown): URL | null {
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

  return parsed;
}

/** Заголовок вики-страницы читается человеком, поэтому возвращается расшифрованным. */
function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostLabel(hostname: string): string {
  return hostname.replace(/^www\./i, '');
}

function wikiProviderHint(hostname: string): string {
  const parts = hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const project = parts.length >= 2 ? parts[parts.length - 2] : hostname;
  const projectName = project.charAt(0).toUpperCase() + project.slice(1);
  // `ru.wikisource.org` → «Wikisource (ru)»; `wikisource.org` → «Wikisource».
  const language = parts.length >= 3 ? parts[0] : null;
  return language ? `${projectName} (${language})` : projectName;
}

function deriveGutenberg(parsed: URL): DerivedSourceFromUrl {
  for (const pattern of GUTENBERG_ID_PATTERNS) {
    const match = pattern.exec(parsed.pathname);
    if (match) {
      return {
        provider: 'PROJECT_GUTENBERG',
        externalId: match[1],
        providerHint: 'Project Gutenberg',
        kind: 'GUTENBERG',
      };
    }
  }

  return {
    provider: 'PROJECT_GUTENBERG',
    externalId: null,
    providerHint: 'Project Gutenberg',
    kind: 'GUTENBERG',
  };
}

export function deriveSourceFromUrl(url: unknown): DerivedSourceFromUrl | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return null;
  }

  const hostname = parsed.hostname;

  if (GUTENBERG_HOST.test(hostname)) {
    return deriveGutenberg(parsed);
  }

  if (WIKI_HOST.test(hostname)) {
    const match = WIKI_TITLE_PATTERN.exec(parsed.pathname);
    return {
      provider: 'OTHER',
      externalId: match ? decodePathSegment(match[1]) : null,
      providerHint: wikiProviderHint(hostname),
      kind: 'COMMUNITY_WIKI',
    };
  }

  if (ARCHIVE_HOST.test(hostname)) {
    const match = ARCHIVE_ID_PATTERN.exec(parsed.pathname);
    return {
      provider: 'OTHER',
      externalId: match ? decodePathSegment(match[1]) : null,
      providerHint: 'Internet Archive',
      kind: 'DIGITAL_LIBRARY',
    };
  }

  if (STANDARD_EBOOKS_HOST.test(hostname)) {
    const match = STANDARD_EBOOKS_ID_PATTERN.exec(parsed.pathname);
    return {
      provider: 'OTHER',
      externalId: match ? decodePathSegment(match[1]) : null,
      providerHint: 'Standard Ebooks',
      kind: 'DIGITAL_LIBRARY',
    };
  }

  if (HATHITRUST_HOST.test(hostname)) {
    const id = parsed.searchParams.get('id');
    return {
      provider: 'OTHER',
      externalId: id && id.trim() !== '' ? id.trim() : null,
      providerHint: 'HathiTrust',
      kind: 'DIGITAL_LIBRARY',
    };
  }

  return {
    provider: 'OTHER',
    externalId: null,
    providerHint: hostLabel(hostname),
    kind: 'UNKNOWN_WEB',
  };
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

/**
 * WP-M.1: у незнакомой площадки тип текста не выводится даже при совпадении языков. Про
 * Gutenberg, Викитеку и цифровые библиотеки известно, что они выкладывают тексты произведений;
 * про случайный сайт не известно ничего, и `ORIGINAL_TEXT` там был бы догадкой на догадке.
 */
export function mayInferTextTypeFrom(derived: DerivedSourceFromUrl | null): boolean {
  return derived !== null && derived.kind !== 'UNKNOWN_WEB';
}
