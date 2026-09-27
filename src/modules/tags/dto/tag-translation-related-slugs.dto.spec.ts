import { Language } from '@prisma/client';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { CreateTagTranslationDto } from './create-tag-translation.dto';
import { UpdateTagTranslationDto } from './update-tag-translation.dto';

const fields = [
  'relatedTagSlugs',
  'relatedGenreSlugs',
  'relatedCategorySlugs',
  'relatedCollectionSlugs',
];

const paths: Array<[string, new () => object, Record<string, unknown>]> = [
  [
    'создание',
    CreateTagTranslationDto,
    { language: Language.en, name: 'Aestheticism', slug: 'aestheticism' },
  ],
  ['PATCH', UpdateTagTranslationDto, {}],
];

describe('Форма слага у элементов related*Slugs перевода тега (LEGACY-401, T57)', () => {
  describe.each(paths)('%s', (_name, dto, base) => {
    it.each(fields)('%s принимает слаги', (field) => {
      expect(dtoFieldErrors(dto, { ...base, [field]: ['beauty', 'gothic-fiction'] })).toEqual([]);
    });

    it.each(fields)('%s отбивает элемент не по форме слага', (field) => {
      expect(dtoFieldErrors(dto, { ...base, [field]: ['Not A Slug!!'] })).toContain(field);
      expect(dtoFieldErrors(dto, { ...base, [field]: ['beauty', ''] })).toContain(field);
    });
  });
});
