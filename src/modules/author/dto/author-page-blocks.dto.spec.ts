import { readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { AuthorTranslationDto } from './author-translation.dto';
import { CreateAuthorDto } from './create-author.dto';

/**
 * F02-2: форма блоков страницы автора на записи (`tech.md` F02 §2). Пути ошибок — как их
 * собрал бы боевой `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`, `main.ts`).
 */
const paths = (errors: ValidationError[], prefix = ''): string[] =>
  errors.flatMap((e) => {
    const path = /^\d+$/.test(e.property)
      ? `${prefix}[${e.property}]`
      : prefix
        ? `${prefix}.${e.property}`
        : e.property;
    return e.children && e.children.length > 0 ? paths(e.children, path) : [path];
  });

const validate = <T extends object>(dto: new () => T, payload: Record<string, unknown>) =>
  paths(
    validateSync(plainToInstance(dto, payload), { whitelist: true, forbidNonWhitelisted: true }),
  );

const base = { language: 'en', name: 'Leo Tolstoy', slug: 'leo-tolstoy' };
const translationErrors = (overrides: Record<string, unknown>) =>
  validate(AuthorTranslationDto, { ...base, ...overrides });

describe('AuthorTranslationDto: блоки страницы автора (F02-2)', () => {
  const valid: Record<string, unknown> = {
    tagline: 'Russian writer',
    facts: { gender: 'male', birthPlace: 'Yasnaya Polyana', occupations: ['novelist'] },
    notableWorks: [{ title: 'War and Peace', year: 1869, bookSlug: null }],
    startHere: [{ bookSlug: 'anna-karenina', reason: 'Short and clear.' }],
    timeline: [{ year: -400, text: 'Antiquity is allowed', bookSlug: null }],
    influences: { influencedBy: [{ name: 'Rousseau', authorSlug: null }], influenced: [] },
    awards: [{ name: 'Nobel Prize in Literature', year: 1902, nomination: true }],
    adaptations: [{ title: 'War and Peace', year: 1956, kind: 'film', basedOn: 'War and Peace' }],
    funFacts: [{ text: 'Fact', sourceTitle: 'Britannica', sourceUrl: 'https://britannica.com/x' }],
    sources: [{ title: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q7243' }],
    quotes: [{ text: 'Quote', source: 'Anna Karenina', bookSlug: 'anna-karenina' }],
  };

  it('верная форма каждого блока проходит', () => {
    expect(translationErrors(valid)).toEqual([]);
  });

  it.each(Object.keys(valid))('null у %s — блок очищается, не ошибка', (field) => {
    expect(translationErrors({ [field]: null })).toEqual([]);
  });

  it.each([
    ['facts', { ...(valid.facts as object), extra: 1 }, 'facts.extra'],
    ['notableWorks', [{ title: 'X', extra: 1 }], 'notableWorks[0].extra'],
    ['startHere', [{ bookSlug: 'x', reason: 'y', extra: 1 }], 'startHere[0].extra'],
    ['timeline', [{ year: 1900, text: 'x', extra: 1 }], 'timeline[0].extra'],
    ['influences', { influencedBy: [{ name: 'x', extra: 1 }] }, 'influences.influencedBy[0].extra'],
    ['awards', [{ name: 'x', extra: 1 }], 'awards[0].extra'],
    ['adaptations', [{ title: 'x', kind: 'film', extra: 1 }], 'adaptations[0].extra'],
    [
      'funFacts',
      [{ text: 'x', sourceTitle: 'y', sourceUrl: 'https://e.org', extra: 1 }],
      'funFacts[0].extra',
    ],
    ['sources', [{ title: 'x', url: 'https://e.org', extra: 1 }], 'sources[0].extra'],
    ['quotes', [{ text: 'x', extra: 1 }], 'quotes[0].extra'],
  ])('лишнее поле в %s отбивается с путём', (field, value, path) => {
    expect(translationErrors({ [field]: value })).toContain(path);
  });

  it.each([
    ['tagline', 'x'.repeat(141), 'tagline'],
    ['notableWorks', Array.from({ length: 8 }, () => ({ title: 'x' })), 'notableWorks'],
    ['startHere', Array.from({ length: 6 }, () => ({ bookSlug: 'x', reason: 'y' })), 'startHere'],
    ['startHere', [{ bookSlug: 'x', reason: 'y'.repeat(221) }], 'startHere[0].reason'],
    ['timeline', Array.from({ length: 16 }, () => ({ year: 1900, text: 'x' })), 'timeline'],
    ['timeline', [{ year: 1900, text: 'x'.repeat(201) }], 'timeline[0].text'],
    [
      'influences',
      { influenced: Array.from({ length: 9 }, () => ({ name: 'x' })) },
      'influences.influenced',
    ],
    ['awards', Array.from({ length: 21 }, () => ({ name: 'x' })), 'awards'],
    [
      'adaptations',
      Array.from({ length: 11 }, () => ({ title: 'x', kind: 'film' })),
      'adaptations',
    ],
    [
      'funFacts',
      Array.from({ length: 6 }, () => ({
        text: 'x',
        sourceTitle: 'y',
        sourceUrl: 'https://e.org',
      })),
      'funFacts',
    ],
    [
      'funFacts',
      [{ text: 'x'.repeat(301), sourceTitle: 'y', sourceUrl: 'https://e.org' }],
      'funFacts[0].text',
    ],
    [
      'sources',
      Array.from({ length: 11 }, () => ({ title: 'x', url: 'https://e.org' })),
      'sources',
    ],
    ['quotes', Array.from({ length: 51 }, () => ({ text: 'q' })), 'quotes'],
  ])('превышение лимита в %s отбивается (%#)', (field, value, path) => {
    expect(translationErrors({ [field]: value })).toContain(path);
  });

  it('факт без источника отбивается с путём', () => {
    const errors = translationErrors({
      funFacts: [
        { text: 'ok', sourceTitle: 'Britannica', sourceUrl: 'https://britannica.com' },
        { text: 'no source', sourceTitle: 'Britannica', sourceUrl: '' },
        { text: 'no title', sourceTitle: '  ', sourceUrl: 'https://e.org' },
      ],
    });
    expect(errors).toEqual(['funFacts[1].sourceUrl', 'funFacts[2].sourceTitle']);
  });

  it('источник факта — только абсолютный http(s)', () => {
    expect(
      translationErrors({
        funFacts: [{ text: 'x', sourceTitle: 'y', sourceUrl: 'javascript:alert(1)' }],
      }),
    ).toEqual(['funFacts[0].sourceUrl']);
  });

  it('год — целое число, не строка и не дробь', () => {
    expect(translationErrors({ timeline: [{ year: 1900.5, text: 'x' }] })).toContain(
      'timeline[0].year',
    );
    expect(translationErrors({ awards: [{ name: 'x', year: 'soon' }] })).toContain(
      'awards[0].year',
    );
  });

  it('пустой год события хронологии — отказ, а не год 0', () => {
    expect(translationErrors({ timeline: [{ year: '', text: 'x' }] })).toEqual([
      'timeline[0].year',
    ]);
    expect(translationErrors({ timeline: [{ year: '1852', text: 'x' }] })).toEqual([]);
  });

  it('пустой год — нет значения, а не год 0', () => {
    const instance = plainToInstance(AuthorTranslationDto, {
      ...base,
      awards: [
        { name: 'x', year: '' },
        { name: 'y', year: '  ' },
        { name: 'z', year: '1902' },
      ],
    });
    expect(paths(validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }))).toEqual(
      [],
    );
    expect(instance.awards?.map((a) => a.year)).toEqual([undefined, undefined, 1902]);
  });

  it('слаг книги и автора в блоках — формат слага сайта', () => {
    expect(
      translationErrors({
        startHere: [{ bookSlug: 'Anna Karenina', reason: 'r' }],
        notableWorks: [{ title: 'x', bookSlug: 'anna-karenina/' }],
        influences: { influencedBy: [{ name: 'x', authorSlug: 'Oscar_Wilde' }] },
        quotes: [{ text: 'q', bookSlug: 'Anna!' }],
      }).sort(),
    ).toEqual(
      [
        'influences.influencedBy[0].authorSlug',
        'notableWorks[0].bookSlug',
        'quotes[0].bookSlug',
        'startHere[0].bookSlug',
      ].sort(),
    );
  });

  it('вид экранизации — только из перечня', () => {
    expect(translationErrors({ adaptations: [{ title: 'x', kind: 'musical' }] })).toEqual([
      'adaptations[0].kind',
    ]);
  });

  it('пол — male, female или null', () => {
    expect(translationErrors({ facts: { gender: 'other' } })).toEqual(['facts.gender']);
    expect(translationErrors({ facts: { gender: null } })).toEqual([]);
  });

  it('пустая строка у необязательного поля — нет значения, у обязательного — отказ', () => {
    expect(translationErrors({ facts: { birthPlace: '' }, tagline: '' })).toEqual([]);
    expect(translationErrors({ notableWorks: [{ title: '' }] })).toEqual(['notableWorks[0].title']);
  });

  it('автор, заполненный до F02 (биография, цитаты без bookSlug, FAQ), проходит', () => {
    expect(
      translationErrors({
        biography: '<p>Bio</p>',
        quotes: [{ text: 'Old quote', source: 'Somewhere' }],
        faq: [{ question: 'Q?', answer: 'A.' }],
        similarSlugs: ['oscar-wilde'],
      }),
    ).toEqual([]);
  });
});

describe('CreateAuthorDto: родное имя и подпись к портрету (F02-2)', () => {
  const author = (overrides: Record<string, unknown>) =>
    validate(CreateAuthorDto, { translations: [base], ...overrides });

  it('подпись с автором и лицензией проходит, ссылки необязательны', () => {
    expect(
      author({ nativeName: 'Лев Толстой', photoCredit: { author: 'X', license: 'Public domain' } }),
    ).toEqual([]);
  });

  it('подпись без лицензии и со ссылкой не http(s) отбивается с путём', () => {
    expect(author({ photoCredit: { author: 'X', licenseUrl: 'ftp://e.org/l' } }).sort()).toEqual([
      'photoCredit.license',
      'photoCredit.licenseUrl',
    ]);
  });

  it('null очищает', () => {
    expect(author({ nativeName: null, photoCredit: null })).toEqual([]);
  });
});

describe('example-author.json проходит DTO записи (F02-2)', () => {
  // Копия эталона books-app-docs/features/F02-author-page/prompts/example-author.json
  // (решение арбитра 15.10.2026, `F02 | F02-2`): ссылаться на соседний репозиторий нельзя.
  const example = JSON.parse(
    readFileSync(join(__dirname, '../../../../test/fixtures/example-author.json'), 'utf8'),
  ) as {
    translations: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;

  it('весь автор с переводами — без ошибок', () => {
    const translations = Object.entries(example.translations).map(([language, t]) => ({
      language,
      ...t,
    }));
    expect(validate(CreateAuthorDto, { ...example, translations })).toEqual([]);
  });
});
