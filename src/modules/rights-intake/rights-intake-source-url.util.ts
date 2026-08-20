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
 * Новых значений enum-а `RightsSourceProvider` при этом не заводится: миграции у этапа нет,
 * а площадка называется в `providerHint`, который агент видит в манифесте.
 *
 * Зеркало этого файла живёт во фронте (`books-front/lib/utils/rights-source-url.ts`) и
 * правится только вместе с ним: расхождение двух разборов — это разные значения в форме
 * и в базе, и заметно оно только на живом интейке.
 */

/** Вид площадки. От него зависят пункты задания агенту и то, выводится ли тип текста. */
export type DerivedSourceKind =
  /** Project Gutenberg: своя обвязка в файлах и своё, американское, заявление о PD. */
  | 'GUTENBERG'
  /** Викитека: текст произведения набран сообществом, у самой расшифровки своя лицензия. */
  | 'COMMUNITY_WIKI'
  /** Цифровая библиотека: у каждой единицы хранения своё заявление о правах. */
  | 'DIGITAL_LIBRARY'
  /** Всё остальное: про площадку неизвестно ничего, и это тоже сведение для агента. */
  | 'UNKNOWN_WEB';

export interface DerivedSourceFromUrl {
  /**
   * Значение enum-а `RightsSourceProvider` для узнанной площадки. Всё, что не Gutenberg, —
   * `OTHER`: заводить значение enum-а на каждый сайт означало бы миграцию на каждый источник.
   *
   * `null` — площадка не узнана, и провайдер интейка не трогается. `OTHER` здесь был бы
   * подлогом: это не знание о площадке, а то же «неизвестно», записанное значением enum-а.
   * Разница видна снаружи: `readiness` перестал бы предупреждать `SOURCE_PROVIDER_UNKNOWN`,
   * а фильтр `?sourceProvider=UNKNOWN` — находить такие записи.
   */
  provider: 'PROJECT_GUTENBERG' | 'OTHER' | null;
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

const WIKISOURCE_HOST = /(^|\.)wikisource\.org$/i;

/**
 * Остальные проекты Викимедиа. Идентификатор страницы у них читается так же, но текстом
 * произведения они не являются: статья Википедии ничего не воспроизводит и лежит под CC BY-SA,
 * файл на Викискладе — вообще не текст. Поэтому вид площадки у них `UNKNOWN_WEB`, и тип текста
 * из совпадения языков не выводится: задание «найди печатное издание, которое это
 * воспроизводит» к энциклопедической статье неприменимо.
 */
const WIKIMEDIA_HOST = /(^|\.)(wikipedia|wikibooks|wikiquote|wikimedia)\.org$/i;

/**
 * Только сам `archive.org`. `web.archive.org` — это Wayback, снимок произвольного сайта:
 * заявления о правах у него нет, а `/details/` может встретиться внутри архивного пути
 * и дать чужой идентификатор.
 */
const ARCHIVE_HOST = /^(www\.)?archive\.org$/i;
const STANDARD_EBOOKS_HOST = /(^|\.)standardebooks\.org$/i;
const HATHITRUST_HOST = /(^|\.)hathitrust\.org$/i;

/** `/wiki/<заголовок>` у любого проекта Викимедиа. */
const WIKI_TITLE_PATTERN = /\/wiki\/(.+)$/i;
/** `/details/<идентификатор>` у Internet Archive — только в начале пути. */
const ARCHIVE_ID_PATTERN = /^\/details\/([^/]+)/i;
/** `/ebooks/<автор>/<произведение>` у Standard Ebooks; хвост вида `/text/single-page` не в счёт. */
const STANDARD_EBOOKS_ID_PATTERN = /^\/ebooks\/([^/]+\/[^/]+)/i;

/**
 * Предел длины внешнего ID. Ровно столько принимает `@MaxLength(100)` в DTO интейка, и это
 * единственное место, где предел вообще проверяется: колонка в базе не ограничена.
 */
const MAX_EXTERNAL_ID_LENGTH = 100;

/** Код языкового раздела вики: `ru`, `en`, `zh-yue`. `commons`, `meta`, `www` — не языки. */
const WIKI_LANGUAGE_LABEL = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;

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

/**
 * Выведенный ID длиннее предела не подставляется вовсе. Обрезанный заголовок вики-страницы —
 * это уже другая страница, а не сокращённая запись той же; пустое поле честнее и с WP-M.1
 * стоит всего лишь предупреждением. Иначе форма молча заполняет поле сама, и сохранение
 * падает 400 на значении, которого редактор не вводил: подстраница Викитеки
 * (`/wiki/Полное_собрание_сочинений…/Том_6/Преступление_и_наказание/Часть_первая`) и полный
 * путь Standard Ebooks выходят за сотню символов легко.
 */
function fitExternalId(value: string | null): string | null {
  if (value === null || value === '') {
    return null;
  }
  return value.length > MAX_EXTERNAL_ID_LENGTH ? null : value;
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
  // Третья метка — не всегда язык: у `commons.wikimedia.org` в скобках оказывался бы
  // несуществующий код языка, и агент читал бы его как язык раздела.
  const label = parts.length >= 3 ? parts[0] : null;
  return label !== null && WIKI_LANGUAGE_LABEL.test(label)
    ? `${projectName} (${label})`
    : projectName;
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

  if (WIKISOURCE_HOST.test(hostname)) {
    const match = WIKI_TITLE_PATTERN.exec(parsed.pathname);
    return {
      provider: 'OTHER',
      externalId: fitExternalId(match ? decodePathSegment(match[1]) : null),
      providerHint: wikiProviderHint(hostname),
      kind: 'COMMUNITY_WIKI',
    };
  }

  if (WIKIMEDIA_HOST.test(hostname)) {
    const match = WIKI_TITLE_PATTERN.exec(parsed.pathname);
    return {
      provider: null,
      externalId: fitExternalId(match ? decodePathSegment(match[1]) : null),
      providerHint: wikiProviderHint(hostname),
      kind: 'UNKNOWN_WEB',
    };
  }

  if (ARCHIVE_HOST.test(hostname)) {
    const match = ARCHIVE_ID_PATTERN.exec(parsed.pathname);
    return {
      provider: 'OTHER',
      externalId: fitExternalId(match ? decodePathSegment(match[1]) : null),
      providerHint: 'Internet Archive',
      kind: 'DIGITAL_LIBRARY',
    };
  }

  if (STANDARD_EBOOKS_HOST.test(hostname)) {
    const match = STANDARD_EBOOKS_ID_PATTERN.exec(parsed.pathname);
    return {
      provider: 'OTHER',
      externalId: fitExternalId(match ? decodePathSegment(match[1]) : null),
      providerHint: 'Standard Ebooks',
      kind: 'DIGITAL_LIBRARY',
    };
  }

  if (HATHITRUST_HOST.test(hostname)) {
    const id = parsed.searchParams.get('id');
    return {
      provider: 'OTHER',
      externalId: fitExternalId(id !== null && id.trim() !== '' ? id.trim() : null),
      providerHint: 'HathiTrust',
      kind: 'DIGITAL_LIBRARY',
    };
  }

  return {
    provider: null,
    externalId: null,
    providerHint: hostLabel(hostname),
    kind: 'UNKNOWN_WEB',
  };
}

/**
 * Вид площадки для задания агенту. Сохранённый провайдер сильнее ссылки: он установлен
 * человеком, а ссылки может не быть вовсе.
 *
 * Без этого интейк с `sourceProvider = PROJECT_GUTENBERG` и пустым `sourceUrl` не получал
 * ни одного пункта про площадку, хотя до WP-M.1 пункт про Gutenberg стоял в списке всегда;
 * а ссылка на зеркало (`gutenberg.net.au`, `gutenberg.ca` — другие хосты) давала агенту
 * «сайт не известен» рядом с `provider: PROJECT_GUTENBERG` в том же манифесте.
 */
export function resolveSourceKind(
  storedProvider: unknown,
  derived: DerivedSourceFromUrl | null,
): DerivedSourceKind | null {
  if (storedProvider === 'PROJECT_GUTENBERG') {
    return 'GUTENBERG';
  }
  return derived?.kind ?? null;
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
 * про случайный сайт и про статью Википедии — нет, и `ORIGINAL_TEXT` там был бы догадкой
 * на догадке.
 */
export function canInferTextTypeFrom(derived: DerivedSourceFromUrl | null): boolean {
  return derived !== null && derived.kind !== 'UNKNOWN_WEB';
}
