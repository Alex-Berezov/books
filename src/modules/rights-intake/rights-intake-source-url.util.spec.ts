import {
  deriveSourceFromUrl,
  isSameLanguage,
  mayInferTextTypeFrom,
} from './rights-intake-source-url.util';

/**
 * WP-M.1: разбор ссылки перестал быть про один Project Gutenberg. Повод — живой кейс
 * «Преступление и наказание» с ru.wikisource.org: интейк оставался с провайдером `UNKNOWN`,
 * а редактор, чтобы закрыть пробел «не указан внешний ID», вписывал в поле строку `null`.
 */
describe('deriveSourceFromUrl', () => {
  it('не разбирает пустое значение, мусор и не-HTTP схему', () => {
    expect(deriveSourceFromUrl(null)).toBeNull();
    expect(deriveSourceFromUrl('')).toBeNull();
    expect(deriveSourceFromUrl('   ')).toBeNull();
    expect(deriveSourceFromUrl('не ссылка')).toBeNull();
    expect(deriveSourceFromUrl('ftp://gutenberg.org/ebooks/932')).toBeNull();
    expect(deriveSourceFromUrl(42)).toBeNull();
  });

  describe('Project Gutenberg', () => {
    it.each([
      ['https://www.gutenberg.org/ebooks/932', '932'],
      ['https://www.gutenberg.org/files/932/932-0.txt', '932'],
      ['https://gutenberg.org/cache/epub/932/pg932.txt', '932'],
      ['https://www.gutenberg.org/etext/932', '932'],
    ])('выводит номер книги из %s', (url, expected) => {
      const derived = deriveSourceFromUrl(url);

      expect(derived).toEqual({
        provider: 'PROJECT_GUTENBERG',
        externalId: expected,
        providerHint: 'Project Gutenberg',
        kind: 'GUTENBERG',
      });
    });

    it('узнаёт площадку и без номера в адресе', () => {
      const derived = deriveSourceFromUrl('https://www.gutenberg.org/about/');

      expect(derived?.provider).toBe('PROJECT_GUTENBERG');
      expect(derived?.externalId).toBeNull();
    });
  });

  describe('вики-проекты', () => {
    it('берёт заголовок страницы Викитеки как внешний ID и расшифровывает его', () => {
      const derived = deriveSourceFromUrl(
        'https://ru.wikisource.org/wiki/%D0%9F%D1%80%D0%B5%D1%81%D1%82%D1%83%D0%BF%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5_%D0%B8_%D0%BD%D0%B0%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%B8%D0%B5_(%D0%94%D0%BE%D1%81%D1%82%D0%BE%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B9)',
      );

      expect(derived).toEqual({
        provider: 'OTHER',
        externalId: 'Преступление_и_наказание_(Достоевский)',
        providerHint: 'Wikisource (ru)',
        kind: 'COMMUNITY_WIKI',
      });
    });

    it('называет язык раздела в имени площадки', () => {
      expect(deriveSourceFromUrl('https://en.wikisource.org/wiki/Hamlet')?.providerHint).toBe(
        'Wikisource (en)',
      );
      expect(deriveSourceFromUrl('https://wikisource.org/wiki/Main_Page')?.providerHint).toBe(
        'Wikisource',
      );
    });

    it('относит Википедию и Викисклад к той же категории', () => {
      expect(deriveSourceFromUrl('https://ru.wikipedia.org/wiki/Достоевский')?.kind).toBe(
        'COMMUNITY_WIKI',
      );
      expect(deriveSourceFromUrl('https://commons.wikimedia.org/wiki/File:X.jpg')?.kind).toBe(
        'COMMUNITY_WIKI',
      );
    });
  });

  describe('цифровые библиотеки', () => {
    it('берёт идентификатор единицы хранения Internet Archive', () => {
      expect(deriveSourceFromUrl('https://archive.org/details/crimeandpunishm00dost')).toEqual({
        provider: 'OTHER',
        externalId: 'crimeandpunishm00dost',
        providerHint: 'Internet Archive',
        kind: 'DIGITAL_LIBRARY',
      });
    });

    it('берёт слаг Standard Ebooks', () => {
      expect(
        deriveSourceFromUrl(
          'https://standardebooks.org/ebooks/fyodor-dostoevsky/crime-and-punishment',
        )?.externalId,
      ).toBe('fyodor-dostoevsky/crime-and-punishment');
    });

    it('берёт идентификатор HathiTrust из параметра запроса', () => {
      const derived = deriveSourceFromUrl('https://babel.hathitrust.org/cgi/pt?id=uc1.b000123');

      expect(derived?.providerHint).toBe('HathiTrust');
      expect(derived?.externalId).toBe('uc1.b000123');
    });
  });

  describe('незнакомая площадка', () => {
    it('даёт OTHER и хост вместо имени, но не выдумывает внешний ID', () => {
      expect(deriveSourceFromUrl('https://www.example.com/books/932')).toEqual({
        provider: 'OTHER',
        externalId: null,
        providerHint: 'example.com',
        kind: 'UNKNOWN_WEB',
      });
    });
  });
});

describe('mayInferTextTypeFrom', () => {
  it('разрешает вывод типа текста только для узнанных площадок', () => {
    expect(mayInferTextTypeFrom(deriveSourceFromUrl('https://www.gutenberg.org/ebooks/932'))).toBe(
      true,
    );
    expect(mayInferTextTypeFrom(deriveSourceFromUrl('https://ru.wikisource.org/wiki/X'))).toBe(
      true,
    );
    expect(mayInferTextTypeFrom(deriveSourceFromUrl('https://example.com/x'))).toBe(false);
    expect(mayInferTextTypeFrom(null)).toBe(false);
  });
});

describe('isSameLanguage', () => {
  it('сравнивает коды без учёта регистра и пробелов', () => {
    expect(isSameLanguage(' RU ', 'ru')).toBe(true);
    expect(isSameLanguage('ru', 'en')).toBe(false);
    expect(isSameLanguage('', '')).toBe(false);
    expect(isSameLanguage(null, 'ru')).toBe(false);
  });
});
