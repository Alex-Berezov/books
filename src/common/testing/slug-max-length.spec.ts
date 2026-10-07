import { dtoFieldErrors } from './dto-field-errors';
import { SLUG_MAX_LENGTH } from '../../shared/validators/slug';
import { CreatePageDto } from '../../modules/pages/dto/create-page.dto';
import { UpdatePageDto } from '../../modules/pages/dto/update-page.dto';
import { CreateCategoryDto } from '../../modules/category/dto/create-category.dto';
import { UpdateCategoryDto } from '../../modules/category/dto/update-category.dto';
import { CreateCategoryTranslationDto } from '../../modules/category/dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from '../../modules/category/dto/update-category-translation.dto';
import { CreateTagDto } from '../../modules/tags/dto/create-tag.dto';
import { UpdateTagDto } from '../../modules/tags/dto/update-tag.dto';
import { CreateTagTranslationDto } from '../../modules/tags/dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from '../../modules/tags/dto/update-tag-translation.dto';

/**
 * `LEGACY-437`: предел длины слага страниц, категорий, тегов и их переводов. Новый слаг держит
 * Create-DTO; Update-DTO длину не проверяет — текущего слага он не знает, а неизменный слаг старой
 * записи длиннее предела проходить обязан. Изменённый слаг отбивает сервис (`assertChangedSlugLength`).
 */
describe('slug length limit (LEGACY-437)', () => {
  const atLimit = 'a'.repeat(SLUG_MAX_LENGTH);
  const overLimit = 'a'.repeat(SLUG_MAX_LENGTH + 1);

  it.each([
    ['CreatePageDto', CreatePageDto],
    ['CreateCategoryDto', CreateCategoryDto],
    ['CreateCategoryTranslationDto', CreateCategoryTranslationDto],
    ['CreateTagDto', CreateTagDto],
    ['CreateTagTranslationDto', CreateTagTranslationDto],
  ] as const)(
    '%s отбивает новый слаг длиннее предела и пропускает слаг на пределе',
    (_name, dto) => {
      expect(dtoFieldErrors(dto as new () => object, { slug: overLimit })).toContain('slug');
      expect(dtoFieldErrors(dto as new () => object, { slug: atLimit })).not.toContain('slug');
    },
  );

  it.each([
    ['UpdatePageDto', UpdatePageDto],
    ['UpdateCategoryDto', UpdateCategoryDto],
    ['UpdateCategoryTranslationDto', UpdateCategoryTranslationDto],
    ['UpdateTagDto', UpdateTagDto],
    ['UpdateTagTranslationDto', UpdateTagTranslationDto],
  ] as const)('%s длину не проверяет: неизменный слаг старой записи — не отказ', (_name, dto) => {
    expect(dtoFieldErrors(dto as new () => object, { slug: overLimit })).not.toContain('slug');
  });
});
