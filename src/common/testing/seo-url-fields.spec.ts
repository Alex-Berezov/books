import { Language } from '@prisma/client';
import { dtoFieldErrors } from './dto-field-errors';
import { ImportTagTranslationDto } from '../../modules/import/dto/import-tag.dto';
import { ImportCategoryTranslationDto } from '../../modules/import/dto/import-category.dto';
import { CreateTagTranslationDto } from '../../modules/tags/dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from '../../modules/tags/dto/update-tag-translation.dto';
import { CreateCategoryTranslationDto } from '../../modules/category/dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from '../../modules/category/dto/update-category-translation.dto';

const tagBase = { name: 'Aestheticism', slug: 'aestheticism' };
const categoryBase = { name: 'Victorian Literature', slug: 'victorian-literature' };

// Все пути записи `TagTranslation`/`CategoryTranslation` URL-колонок — одна форма (`LEGACY-401`, `T57`).
const paths: Array<[string, new () => object, Record<string, unknown>, string]> = [
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
];

describe('IsAbsoluteHttpUrl на всех путях записи SEO-URL переводов (LEGACY-401)', () => {
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
    for (const value of ['example.com', '/en/tag/fear', 'ftp://example.com/x.png', 'not a url']) {
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
