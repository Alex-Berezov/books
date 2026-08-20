import {
  canInferTextTypeFrom,
  deriveSourceFromUrl,
  isSameLanguage,
  resolveSourceKind,
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

  /**
   * Граница хоста. Подмена `endsWith`/`includes` на месте якорных выражений — самая дешёвая
   * ошибка здесь и самая опасная: чужой домен получил бы имя каталога с заявлением о PD.
   */
  describe('граница хоста', () => {
    it.each([
      'https://notgutenberg.org/ebooks/932',
      'https://gutenberg.org.attacker.com/ebooks/932',
      'https://wikisource.org.evil.com/wiki/X',
      'https://myarchive.org/details/x',
      'https://web.archive.org/web/2020/https://example.com/details/x',
    ])('%s не считается узнанной площадкой', (url) => {
      const derived = deriveSourceFromUrl(url);

      expect(derived?.kind).toBe('UNKNOWN_WEB');
      expect(derived?.provider).toBeNull();
      expect(derived?.externalId).toBeNull();
    });
  });

  describe('Project Gutenberg', () => {
    it.each([
      ['https://www.gutenberg.org/ebooks/932', '932'],
      ['https://www.gutenberg.org/files/932/932-0.txt', '932'],
      ['https://gutenberg.org/cache/epub/932/pg932.txt', '932'],
      ['https://www.gutenberg.org/etext/932', '932'],
    ])('выводит номер книги из %s', (url, expected) => {
      expect(deriveSourceFromUrl(url)).toEqual({
        provider: 'PROJECT_GUTENBERG',
        externalId: expected,
        providerHint: 'Project Gutenberg',
        kind: 'GUTENBERG',
      });
    });

    it('узнаёт площадку и без номера в адресе', () => {
      expect(deriveSourceFromUrl('https://www.gutenberg.org/browse/scores/top')).toEqual({
        provider: 'PROJECT_GUTENBERG',
        externalId: null,
        providerHint: 'Project Gutenberg',
        kind: 'GUTENBERG',
      });
    });
  });

  describe('Викитека', () => {
    it('берёт заголовок страницы как внешний ID и расшифровывает его', () => {
      expect(
        deriveSourceFromUrl(
          'https://ru.wikisource.org/wiki/%D0%9F%D1%80%D0%B5%D1%81%D1%82%D1%83%D0%BF%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5_%D0%B8_%D0%BD%D0%B0%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%B8%D0%B5_(%D0%94%D0%BE%D1%81%D1%82%D0%BE%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B9)',
        ),
      ).toEqual({
        provider: 'OTHER',
        externalId: 'Преступление_и_наказание_(Достоевский)',
        providerHint: 'Wikisource (ru)',
        kind: 'COMMUNITY_WIKI',
      });
    });

    it('называет язык раздела в имени площадки только когда это код языка', () => {
      expect(deriveSourceFromUrl('https://en.wikisource.org/wiki/Hamlet')?.providerHint).toBe(
        'Wikisource (en)',
      );
      expect(deriveSourceFromUrl('https://wikisource.org/wiki/Main_Page')?.providerHint).toBe(
        'Wikisource',
      );
      // `commons` — не язык: в скобках агент читал бы несуществующий код языка раздела.
      expect(
        deriveSourceFromUrl('https://commons.wikimedia.org/wiki/File:X.jpg')?.providerHint,
      ).toBe('Wikimedia');
    });

    it('без `/wiki/` в пути внешний ID не выводится', () => {
      const derived = deriveSourceFromUrl('https://ru.wikisource.org/w/index.php?title=X');

      expect(derived?.kind).toBe('COMMUNITY_WIKI');
      expect(derived?.externalId).toBeNull();
    });

    /**
     * У поля `sourceExternalId` в DTO стоит `@MaxLength(100)`. Форма подставляла заголовок
     * сама, и сохранение падало 400 на значении, которого редактор не вводил.
     */
    it('слишком длинный заголовок не подставляется вовсе', () => {
      const longTitle = 'Полное_собрание_сочинений_в_тридцати_томах_(Достоевский)/'.repeat(3);
      const derived = deriveSourceFromUrl(`https://ru.wikisource.org/wiki/${longTitle}`);

      expect(derived?.kind).toBe('COMMUNITY_WIKI');
      expect(derived?.externalId).toBeNull();
    });
  });

  /**
   * Статья Википедии и файл на Викискладе текстом произведения не являются: заданию
   * «найди печатное издание, которое это воспроизводит» соответствовать нечему.
   */
  describe('прочие проекты Викимедиа', () => {
    it.each([
      'https://ru.wikipedia.org/wiki/Достоевский',
      'https://commons.wikimedia.org/wiki/File:X.jpg',
      'https://en.wikiquote.org/wiki/Hamlet',
    ])('%s не считается расшифровкой произведения', (url) => {
      const derived = deriveSourceFromUrl(url);

      expect(derived?.kind).toBe('UNKNOWN_WEB');
      expect(derived?.provider).toBeNull();
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

    it('без `/details/` в начале пути идентификатора у Internet Archive нет', () => {
      const derived = deriveSourceFromUrl('https://archive.org/search?query=dostoevsky');

      expect(derived?.kind).toBe('DIGITAL_LIBRARY');
      expect(derived?.externalId).toBeNull();
    });

    it('берёт у Standard Ebooks только автора и произведение', () => {
      expect(
        deriveSourceFromUrl(
          'https://standardebooks.org/ebooks/fyodor-dostoevsky/crime-and-punishment/text/single-page',
        )?.externalId,
      ).toBe('fyodor-dostoevsky/crime-and-punishment');
    });

    it('берёт идентификатор HathiTrust из параметра запроса', () => {
      const derived = deriveSourceFromUrl('https://babel.hathitrust.org/cgi/pt?id=uc1.b000123');

      expect(derived?.providerHint).toBe('HathiTrust');
      expect(derived?.externalId).toBe('uc1.b000123');
    });

    it('без параметра `id` идентификатора у HathiTrust нет', () => {
      const derived = deriveSourceFromUrl('https://babel.hathitrust.org/cgi/pt');

      expect(derived?.kind).toBe('DIGITAL_LIBRARY');
      expect(derived?.externalId).toBeNull();
    });
  });

  describe('незнакомая площадка', () => {
    it('провайдера не устанавливает, но называет хост', () => {
      expect(deriveSourceFromUrl('https://www.example.com/books/932')).toEqual({
        provider: null,
        externalId: null,
        providerHint: 'example.com',
        kind: 'UNKNOWN_WEB',
      });
    });
  });
});

/**
 * Сохранённый провайдер сильнее ссылки: он установлен человеком, а ссылки может не быть вовсе.
 */
describe('resolveSourceKind', () => {
  it('провайдер Gutenberg даёт вид площадки даже без ссылки', () => {
    expect(resolveSourceKind('PROJECT_GUTENBERG', null)).toBe('GUTENBERG');
  });

  it('провайдер Gutenberg перебивает ссылку на зеркало', () => {
    const mirror = deriveSourceFromUrl('https://gutenberg.net.au/ebooks/x.html');

    expect(mirror?.kind).toBe('UNKNOWN_WEB');
    expect(resolveSourceKind('PROJECT_GUTENBERG', mirror)).toBe('GUTENBERG');
  });

  it('без сохранённого провайдера вид берётся из ссылки', () => {
    const derived = deriveSourceFromUrl('https://ru.wikisource.org/wiki/X');

    expect(resolveSourceKind('UNKNOWN', derived)).toBe('COMMUNITY_WIKI');
    expect(resolveSourceKind('UNKNOWN', null)).toBeNull();
  });
});

describe('canInferTextTypeFrom', () => {
  it('разрешает вывод типа текста только для узнанных площадок с текстами произведений', () => {
    expect(canInferTextTypeFrom(deriveSourceFromUrl('https://www.gutenberg.org/ebooks/932'))).toBe(
      true,
    );
    expect(canInferTextTypeFrom(deriveSourceFromUrl('https://ru.wikisource.org/wiki/X'))).toBe(
      true,
    );
    expect(canInferTextTypeFrom(deriveSourceFromUrl('https://archive.org/details/x'))).toBe(true);
    expect(canInferTextTypeFrom(deriveSourceFromUrl('https://ru.wikipedia.org/wiki/X'))).toBe(
      false,
    );
    expect(canInferTextTypeFrom(deriveSourceFromUrl('https://example.com/x'))).toBe(false);
    expect(canInferTextTypeFrom(null)).toBe(false);
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
