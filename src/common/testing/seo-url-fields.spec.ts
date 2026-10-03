import { Language } from '@prisma/client';
import { dtoFieldErrors } from './dto-field-errors';
import { ImportTagTranslationDto } from '../../modules/import/dto/import-tag.dto';
import { ImportCategoryTranslationDto } from '../../modules/import/dto/import-category.dto';
import { CreateTagTranslationDto } from '../../modules/tags/dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from '../../modules/tags/dto/update-tag-translation.dto';
import { CreateCategoryTranslationDto } from '../../modules/category/dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from '../../modules/category/dto/update-category-translation.dto';
import { UpdateSeoDto } from '../../modules/seo/dto/update-seo.dto';
import { CreatePageDto } from '../../modules/pages/dto/create-page.dto';
import { UpdatePageDto } from '../../modules/pages/dto/update-page.dto';
import { CreateBookVersionDto } from '../../modules/book-version/dto/create-book-version.dto';
import { UpdateBookVersionDto } from '../../modules/book-version/dto/update-book-version.dto';
import { AuthorTranslationDto } from '../../modules/author/dto/author-translation.dto';
import { CreateBookFromClearanceVersionDto } from '../../modules/rights-intake/dto/create-book-from-clearance-version.dto';
import { CreateRightsIntakeDto } from '../../modules/rights-intake/dto/create-rights-intake.dto';
import { CreateLegalChangeDto } from '../../modules/rights-recheck/dto/create-legal-change.dto';
import { UpdateLegalChangeDto } from '../../modules/rights-recheck/dto/update-legal-change.dto';
import { UpdateRightsIntakeDto } from '../../modules/rights-intake/dto/update-rights-intake.dto';
import { UpdateMeDto } from '../../modules/users/dto/update-me.dto';

type Path = [string, new () => object, Record<string, unknown>, string];

const SEO_INPUT_URL_FIELDS = ['canonicalUrl', 'ogUrl', 'ogImageUrl'] as const;
const UPDATE_SEO_URL_FIELDS = [...SEO_INPUT_URL_FIELDS, 'eventUrl', 'eventImageUrl'] as const;

const versionBase = {
  language: Language.en,
  title: 'The Picture of Dorian Gray',
  author: 'Oscar Wilde',
  type: 'text',
  isFree: true,
};

const tagBase = { name: 'Aestheticism', slug: 'aestheticism' };
const categoryBase = { name: 'Victorian Literature', slug: 'victorian-literature' };

// Все пути записи SEO-URL колонок — одна форма (`LEGACY-401`, `T57`, `T62`).
const paths: Path[] = [
  ['импорт тега', ImportTagTranslationDto, tagBase, 'ogImageUrl'],
  ['импорт тега', ImportTagTranslationDto, tagBase, 'canonicalUrl'],
  ['импорт категории', ImportCategoryTranslationDto, categoryBase, 'ogImageUrl'],
  [
    'создание перевода тега',
    CreateTagTranslationDto,
    { ...tagBase, language: Language.en },
    'ogImageUrl',
  ],
  [
    'создание перевода тега',
    CreateTagTranslationDto,
    { ...tagBase, language: Language.en },
    'canonicalUrl',
  ],
  ['PATCH перевода тега', UpdateTagTranslationDto, {}, 'ogImageUrl'],
  ['PATCH перевода тега', UpdateTagTranslationDto, {}, 'canonicalUrl'],
  [
    'создание перевода категории',
    CreateCategoryTranslationDto,
    { ...categoryBase, language: Language.en },
    'ogImageUrl',
  ],
  ['PATCH перевода категории', UpdateCategoryTranslationDto, {}, 'ogImageUrl'],
  ...UPDATE_SEO_URL_FIELDS.map((field): Path => ['PUT /versions/:id/seo', UpdateSeoDto, {}, field]),
  // `T75`: обложка и реферальная ссылка версии — те же абсолютные http(s), что и SEO-адреса.
  ['создание версии', CreateBookVersionDto, versionBase, 'coverImageUrl'],
  ['создание версии', CreateBookVersionDto, versionBase, 'referralUrl'],
  ['PATCH версии', UpdateBookVersionDto, {}, 'coverImageUrl'],
  ['PATCH версии', UpdateBookVersionDto, {}, 'referralUrl'],
  // `T88`: канал клиренса пишет те же колонки версии.
  ['создание книги из клиренса', CreateBookFromClearanceVersionDto, versionBase, 'coverImageUrl'],
  ['создание книги из клиренса', CreateBookFromClearanceVersionDto, versionBase, 'referralUrl'],
];

// Вложенный `seo` (`SeoInputDto`, `UpdateSeoDto`) пишет те же колонки таблицы `Seo`.
const nestedSeo: Array<[string, new () => object, Record<string, unknown>, readonly string[]]> = [
  [
    'создание страницы',
    CreatePageDto,
    { slug: 'about', title: 'About', type: 'generic', content: 'About us' },
    SEO_INPUT_URL_FIELDS,
  ],
  ['PATCH страницы', UpdatePageDto, {}, SEO_INPUT_URL_FIELDS],
  [
    'создание перевода тега',
    CreateTagTranslationDto,
    { ...tagBase, language: Language.en },
    SEO_INPUT_URL_FIELDS,
  ],
  ['PATCH перевода тега', UpdateTagTranslationDto, {}, SEO_INPUT_URL_FIELDS],
  [
    'создание перевода категории',
    CreateCategoryTranslationDto,
    { ...categoryBase, language: Language.en },
    SEO_INPUT_URL_FIELDS,
  ],
  ['PATCH перевода категории', UpdateCategoryTranslationDto, {}, SEO_INPUT_URL_FIELDS],
  [
    'перевод автора',
    AuthorTranslationDto,
    { language: Language.en, name: 'Oscar Wilde', slug: 'oscar-wilde' },
    UPDATE_SEO_URL_FIELDS,
  ],
];
const nestedPaths: Path[] = nestedSeo.flatMap(([name, dto, base, fields]) =>
  fields.map((field): Path => [name, dto, base, field]),
);

const BAD_URLS = ['example.com', '/en/tag/fear', 'ftp://example.com/x.png', 'not a url'];

describe('IsAbsoluteHttpUrl на всех путях записи SEO-URL (LEGACY-401)', () => {
  it.each(paths)('%s: %p.%s принимает абсолютный https', (_name, dto, base, field) => {
    expect(dtoFieldErrors(dto, { ...base, [field]: 'https://bibliaris.com/en/tag/fear' })).toEqual(
      [],
    );
  });

  it.each(paths)(
    '%s: %p.%s принимает адрес LocalStorage на localhost',
    (_name, dto, base, field) => {
      expect(
        dtoFieldErrors(dto, { ...base, [field]: 'http://localhost:5000/uploads/a.png' }),
      ).toEqual([]);
    },
  );

  it.each(paths)('%s: %p.%s отбивает адрес без схемы, путь и ftp', (_name, dto, base, field) => {
    for (const value of BAD_URLS) {
      expect(dtoFieldErrors(dto, { ...base, [field]: value })).toContain(field);
    }
  });

  // `T75`: у обложки версии пустая строка — «не задано», а `null` — 400 (колонка `NOT NULL`),
  // замена валидатора на `IsAbsoluteHttpUrl` не должна сдвинуть ни то, ни другое.
  it('coverImageUrl версии: пустая строка допустима, null отбивается', () => {
    expect(dtoFieldErrors(CreateBookVersionDto, { ...versionBase, coverImageUrl: '' })).toEqual([]);
    expect(dtoFieldErrors(UpdateBookVersionDto, { coverImageUrl: '' })).toEqual([]);
    expect(dtoFieldErrors(CreateBookVersionDto, { ...versionBase, coverImageUrl: null })).toContain(
      'coverImageUrl',
    );
    expect(dtoFieldErrors(UpdateBookVersionDto, { coverImageUrl: null })).toContain(
      'coverImageUrl',
    );
  });

  it('`null` у ogImageUrl импорта по-прежнему допустим', () => {
    expect(dtoFieldErrors(ImportTagTranslationDto, { ...tagBase, ogImageUrl: null })).toEqual([]);
    expect(
      dtoFieldErrors(ImportCategoryTranslationDto, { ...categoryBase, ogImageUrl: null }),
    ).toEqual([]);
  });
});

describe('IsAbsoluteHttpUrl во вложенном seo (LEGACY-401, T62)', () => {
  it.each(nestedPaths)('%s: seo.%s принимает абсолютный https', (_name, dto, base, field) => {
    expect(
      dtoFieldErrors(dto, { ...base, seo: { [field]: 'https://bibliaris.com/en/about' } }),
    ).toEqual([]);
  });

  it.each(nestedPaths)('%s: seo.%s принимает адрес на localhost', (_name, dto, base, field) => {
    expect(
      dtoFieldErrors(dto, { ...base, seo: { [field]: 'http://localhost:5000/uploads/a.png' } }),
    ).toEqual([]);
  });

  it.each(nestedPaths)(
    '%s: seo.%s отбивает адрес без схемы, путь и ftp',
    (_name, dto, base, field) => {
      for (const value of BAD_URLS) {
        expect(dtoFieldErrors(dto, { ...base, seo: { [field]: value } })).toContain('seo');
      }
    },
  );

  it.each(nestedPaths)('%s: seo.%s допускает null', (_name, dto, base, field) => {
    expect(dtoFieldErrors(dto, { ...base, seo: { [field]: null } })).toEqual([]);
  });
});

// `T94`: адреса вне SEO — автор версии, источник приёма, источник правового изменения, аватар.
// Базу не собираем целиком: проверяется только то, попало ли само поле в список ошибок.
describe('Форма URL на остальных путях записи (LEGACY-401, T94)', () => {
  const absolute: Array<[string, new () => object, string]> = [
    ['создание приёма', CreateRightsIntakeDto, 'sourceUrl'],
    // `PATCH` приёма и правового изменения — `PartialType` от DTO создания.
    ['PATCH приёма', UpdateRightsIntakeDto, 'sourceUrl'],
    ['PATCH правового изменения', UpdateLegalChangeDto, 'sourceUrl'],
    ['создание правового изменения', CreateLegalChangeDto, 'sourceUrl'],
    ['PATCH /users/me', UpdateMeDto, 'avatarUrl'],
  ];
  const authorPage: Array<[string, new () => object]> = [
    ['создание версии', CreateBookVersionDto],
    ['PATCH версии', UpdateBookVersionDto],
    ['создание книги из клиренса', CreateBookFromClearanceVersionDto],
  ];
  // Предел длины — `max_allowed_length` у `isURL` (2084), один на обе ветки поля;
  // у `sourceUrl` правового изменения свой `@MaxLength(2000)`.
  const longUrl = (length: number): string => `https://x.test/${'a'.repeat(length - 15)}`;
  const longPath = (length: number): string => `/${'a'.repeat(length - 1)}`;

  const absoluteGood = absolute.flatMap(([name, dto, field]) =>
    ['https://example.com/x', 'http://localhost:5000/x', longUrl(2000)].map(
      (value): [string, new () => object, string, string] => [name, dto, field, value],
    ),
  );
  const absoluteBad = absolute.flatMap(([name, dto, field]) =>
    [...BAD_URLS, longUrl(2085)].map((value): [string, new () => object, string, string] => [
      name,
      dto,
      field,
      value,
    ]),
  );

  it.each(absoluteGood)('%s: %p.%s принимает значение #%#', (_name, dto, field, value) => {
    expect(dtoFieldErrors(dto, { [field]: value })).not.toContain(field);
  });

  it.each(absoluteBad)('%s: %p.%s отбивает значение #%#', (_name, dto, field, value) => {
    expect(dtoFieldErrors(dto, { [field]: value })).toContain(field);
  });

  it.each(absolute)('%s: %p.%s допускает null и отсутствие поля', (_name, dto, field) => {
    expect(dtoFieldErrors(dto, { [field]: null })).not.toContain(field);
    expect(dtoFieldErrors(dto, {})).not.toContain(field);
  });

  // `@IsOptional()` пропускает только `null`/`undefined`: пустая строка — не адрес.
  it.each(absolute)('%s: %p.%s отбивает пустую строку', (_name, dto, field) => {
    expect(dtoFieldErrors(dto, { [field]: '' })).toContain(field);
  });

  const authorPageGood = authorPage.flatMap(([name, dto]) =>
    [
      'https://example.com/author/wilde',
      'http://localhost:5000/a',
      '/ru/author/oscar-wilde',
      '/ru/author/x?a=1#b',
      '/ru/author/оскар',
      '/',
      longPath(2084),
      longUrl(2084),
      null,
    ].map((value): [string, new () => object, string | null] => [name, dto, value]),
  );
  const authorPageBad = authorPage.flatMap(([name, dto]) =>
    [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example/x',
      'ftp://example.com/x',
      'example.com',
      'ru/author/x',
      '/ru/author/<x>',
      '/ru/author/x>',
      '/ru/author/a b',
      '/ru\\evil',
      '/ru/\u0000x',
      '/ru/\u007fx',
      '/ru/\nx',
      longPath(2085),
      longUrl(2085),
    ].map((value): [string, new () => object, string] => [name, dto, value]),
  );

  it.each(authorPageGood)('%s: authorPageUrl принимает значение #%#', (_name, dto, value) => {
    expect(dtoFieldErrors(dto, { authorPageUrl: value })).not.toContain('authorPageUrl');
  });

  it.each(authorPageBad)('%s: authorPageUrl отбивает значение #%#', (_name, dto, value) => {
    expect(dtoFieldErrors(dto, { authorPageUrl: value })).toContain('authorPageUrl');
  });

  it.each(authorPage)('%s: authorPageUrl допускает отсутствие поля', (_name, dto) => {
    expect(dtoFieldErrors(dto, {})).not.toContain('authorPageUrl');
  });

  // `''` — «не задано» в каналах версии, как при прежнем `@IsString()` (решение арбитра
  // 03.10.2026); канал клиренса и раньше отбивал её голым `@IsUrl()` — поведение сохранено.
  it.each([
    ['создание версии', CreateBookVersionDto],
    ['PATCH версии', UpdateBookVersionDto],
  ] as Array<[string, new () => object]>)(
    '%s: authorPageUrl допускает пустую строку',
    (_name, dto) => {
      expect(dtoFieldErrors(dto, { authorPageUrl: '' })).not.toContain('authorPageUrl');
    },
  );

  it('создание книги из клиренса: authorPageUrl отбивает пустую строку', () => {
    expect(dtoFieldErrors(CreateBookFromClearanceVersionDto, { authorPageUrl: '' })).toContain(
      'authorPageUrl',
    );
  });

  // У `sourceUrl` правового изменения свой предел `@MaxLength(2000)` поверх 2084 у `isURL`.
  it('создание правового изменения: sourceUrl длиннее 2000 отбивается', () => {
    expect(dtoFieldErrors(CreateLegalChangeDto, { sourceUrl: longUrl(2000) })).not.toContain(
      'sourceUrl',
    );
    expect(dtoFieldErrors(CreateLegalChangeDto, { sourceUrl: longUrl(2001) })).toContain(
      'sourceUrl',
    );
  });

  it.each(authorPage)('%s: authorPageUrl отбивает не строку', (_name, dto) => {
    for (const value of [123, {}, ['/ru/author/x']]) {
      expect(dtoFieldErrors(dto, { authorPageUrl: value })).toContain('authorPageUrl');
    }
  });
});
