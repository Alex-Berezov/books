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
import { AuthorTranslationDto } from '../../modules/author/dto/author-translation.dto';

type Path = [string, new () => object, Record<string, unknown>, string];

const SEO_INPUT_URL_FIELDS = ['canonicalUrl', 'ogUrl', 'ogImageUrl'] as const;
const UPDATE_SEO_URL_FIELDS = [...SEO_INPUT_URL_FIELDS, 'eventUrl', 'eventImageUrl'] as const;

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
