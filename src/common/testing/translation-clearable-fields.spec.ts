import { Language } from '@prisma/client';
import { dtoFieldErrors } from './dto-field-errors';
import { CreateCategoryTranslationDto } from '../../modules/category/dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from '../../modules/category/dto/update-category-translation.dto';
import { CreateTagTranslationDto } from '../../modules/tags/dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from '../../modules/tags/dto/update-tag-translation.dto';

// `LEGACY-430`, `T87`: пустое поле в админке уходит `null`. Валидатор обязан его пропустить,
// иначе очистка вернётся 400, а сервисные спеки этого не увидят — они идут мимо DTO.
const created = { language: Language.en, name: 'Classics', slug: 'classics' };

const paths: Array<[string, new () => object, Record<string, unknown>]> = [
  ['тег, создание', CreateTagTranslationDto, created],
  ['тег, PATCH', UpdateTagTranslationDto, {}],
  ['категория, создание', CreateCategoryTranslationDto, created],
  ['категория, PATCH', UpdateCategoryTranslationDto, {}],
];

const fields = ['h1', 'metaTitle', 'ogTitle', 'ogImageAlt', 'faq'];

describe('Очищаемые поля перевода тега и категории (LEGACY-430, T87)', () => {
  describe.each(paths)('%s', (_name, dto, base) => {
    it.each(fields)('%s: null проходит', (field) => {
      expect(dtoFieldErrors(dto, { ...base, [field]: null })).toEqual([]);
    });

    it.each(fields)('%s: число отбивается', (field) => {
      expect(dtoFieldErrors(dto, { ...base, [field]: 123 })).toContain(field);
    });
  });
});
