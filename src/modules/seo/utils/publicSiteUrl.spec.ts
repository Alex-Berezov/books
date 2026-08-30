import {
  assertPublicSiteUrl,
  DEFAULT_PUBLIC_SITE_URL,
  resolvePublicSiteUrl,
} from './publicSiteUrl';
import { buildAbsoluteUrl } from './buildAbsoluteUrl';
import { getCanonicalUrl, CanonicalPathType } from '../canonical/getCanonicalUrl';
import { generateHreflangLinks } from '../hreflang/generateHreflangLinks';

/**
 * `LEGACY-319`. Раньше здесь лежала одиннадцатая рукописная копия списка видов
 * пути, и она уже была неполной: `version` в ней отсутствовал, то есть
 * единственный тип адреса без языкового префикса не проверялся вовсе, а выглядел
 * набор исчерпывающим.
 *
 * ⚠️ Список остаётся выписанным руками намеренно: тип — сущность времени
 * компиляции, `Object.values` по нему не пройдёшь. Но полноту теперь стережёт
 * компилятор: `Record<CanonicalPathType, true>` не собирается ни с пропущенным
 * ключом, ни с лишним. Добавили вид пути в `CanonicalPathType` — набор
 * покраснеет на сборке, а не промолчит.
 */
const ALL_CANONICAL_PATH_TYPES: Record<CanonicalPathType, true> = {
  book: true,
  version: true,
  page: true,
  author: true,
  genre: true,
  category: true,
  collection: true,
  tag: true,
  static: true,
};

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('resolvePublicSiteUrl', () => {
  it('falls back to the public domain when PUBLIC_SITE_URL is unset', () => {
    expect(resolvePublicSiteUrl({})).toBe(DEFAULT_PUBLIC_SITE_URL);
  });

  it('never falls back to a storage base URL', () => {
    const resolved = resolvePublicSiteUrl({
      LOCAL_PUBLIC_BASE_URL: 'https://api.bibliaris.com',
      R2_PUBLIC_BASE_URL: 'https://media.bibliaris.com',
    });
    expect(resolved).toBe(DEFAULT_PUBLIC_SITE_URL);
  });

  it('strips a trailing slash', () => {
    expect(resolvePublicSiteUrl({ PUBLIC_SITE_URL: 'https://bibliaris.com/' })).toBe(
      'https://bibliaris.com',
    );
  });
});

describe('assertPublicSiteUrl', () => {
  it('accepts the public origin', () => {
    expect(() =>
      assertPublicSiteUrl({
        PUBLIC_SITE_URL: 'https://bibliaris.com',
        LOCAL_PUBLIC_BASE_URL: 'https://api.bibliaris.com',
        R2_PUBLIC_BASE_URL: 'https://media.bibliaris.com',
      }),
    ).not.toThrow();
  });

  it('accepts an unset value', () => {
    expect(() => assertPublicSiteUrl({})).not.toThrow();
  });

  it.each([
    'https://api.bibliaris.com',
    'https://media.bibliaris.com',
    'https://cdn.bibliaris.com',
    'https://static.bibliaris.com',
  ])('rejects the service host %s', (url) => {
    expect(() => assertPublicSiteUrl({ PUBLIC_SITE_URL: url })).toThrow(/service host/);
  });

  it('rejects a value equal to LOCAL_PUBLIC_BASE_URL', () => {
    expect(() =>
      assertPublicSiteUrl({
        PUBLIC_SITE_URL: 'https://files.example.com',
        LOCAL_PUBLIC_BASE_URL: 'https://files.example.com/',
      }),
    ).toThrow(/must not equal LOCAL_PUBLIC_BASE_URL/);
  });

  it('rejects a value equal to R2_PUBLIC_BASE_URL', () => {
    expect(() =>
      assertPublicSiteUrl({
        PUBLIC_SITE_URL: 'https://files.example.com',
        R2_PUBLIC_BASE_URL: 'https://files.example.com',
      }),
    ).toThrow(/must not equal R2_PUBLIC_BASE_URL/);
  });

  it('rejects a non-absolute value', () => {
    expect(() => assertPublicSiteUrl({ PUBLIC_SITE_URL: '/bibliaris' })).toThrow(/valid absolute/);
  });
});

describe('no service host leaks into SEO output (TZ 2.4)', () => {
  const FORBIDDEN = /(api|media|cdn|static)\.bibliaris\.com/;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      PUBLIC_SITE_URL: 'https://bibliaris.com',
      LOCAL_PUBLIC_BASE_URL: 'https://api.bibliaris.com',
      R2_PUBLIC_BASE_URL: 'https://media.bibliaris.com',
    };
  });

  it('buildAbsoluteUrl uses the public origin', () => {
    expect(buildAbsoluteUrl('/en/tag/fear')).toBe('https://bibliaris.com/en/tag/fear');
    expect(buildAbsoluteUrl('/en/tag/fear')).not.toMatch(FORBIDDEN);
  });

  it.each(Object.keys(ALL_CANONICAL_PATH_TYPES) as CanonicalPathType[])(
    'getCanonicalUrl(%s) uses the public origin',
    (type) => {
      const url = getCanonicalUrl(type, 'slug', 'fr');
      expect(url.startsWith('https://bibliaris.com/')).toBe(true);
      expect(url).not.toMatch(FORBIDDEN);
    },
  );

  it('hreflang alternates use the public origin for every language', () => {
    const links = generateHreflangLinks('tag', {
      en: 'fear',
      es: 'miedo',
      fr: 'peur',
      pt: 'medo',
      ru: 'strah',
    });
    expect(links).toHaveLength(6); // 5 languages + x-default
    links.forEach((link) => {
      expect(link.href.startsWith('https://bibliaris.com/')).toBe(true);
      expect(link.href).not.toMatch(FORBIDDEN);
    });
  });
});
