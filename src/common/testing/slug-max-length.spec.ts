import { readFileSync } from 'fs';
import { dtoFieldErrors } from './dto-field-errors';
import { SRC_ROOT, listFiles, relativeToSrc, stripComments } from './controller-decorators';
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
import { CreateBookVersionDto } from '../../modules/book-version/dto/create-book-version.dto';
import { UpdateBookVersionDto } from '../../modules/book-version/dto/update-book-version.dto';

/**
 * `LEGACY-437`: предел длины слага страниц, категорий, тегов и их переводов, версий книги. Новый слаг держит
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
    ['CreateBookVersionDto', CreateBookVersionDto],
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
    ['UpdateBookVersionDto', UpdateBookVersionDto],
  ] as const)('%s длину не проверяет: неизменный слаг старой записи — не отказ', (_name, dto) => {
    expect(dtoFieldErrors(dto as new () => object, { slug: overLimit })).not.toContain('slug');
  });

  /**
   * Сторож писателей: предел у изменённого слага ставит вызов `assertChangedSlugLength` в сервисе, и держится он
   * вызовом в каждом писателе. Перечень мест заморожен: писатель, потерявший вызов, или новый вызов роняют спеку
   * и требуют решения (новый писатель слага зовёт предел; не писатель прописывается сюда с причиной).
   * Вызов в комментарии вызовом не считается.
   *
   * ⚠️ Слаг автора предела на записи не имеет вовсе (ни `@MaxLength`, ни вызова) — остаток `LEGACY-437`.
   */
  const WRITERS: Record<string, { calls: number; why: string }> = {
    'modules/book-version/book-version.service.ts': {
      calls: 1,
      why: '`update`: слаг версии; Create-DTO держит `@MaxLength`, Update-DTO длину не проверяет',
    },
    'modules/book/book.service.ts': { calls: 1, why: '`update`: `Book.slug`' },
    'modules/category/category.service.ts': {
      calls: 2,
      why: 'правка термина и правка его перевода',
    },
    'modules/import/import.service.ts': {
      calls: 5,
      why: 'импорт категорий и тегов: создание мимо Create-DTO (`current: null`) и правка',
    },
    'modules/pages/pages.service.ts': { calls: 1, why: '`update` страницы' },
    'modules/tags/tags.service.ts': { calls: 2, why: 'правка тега и правка его перевода' },
  };

  it('вызовы assertChangedSlugLength совпадают с замороженным перечнем писателей', () => {
    const counts: Record<string, number> = {};
    for (const file of listFiles(
      SRC_ROOT,
      (path) => path.endsWith('.ts') && !path.includes('.spec.'),
    )) {
      const rel = relativeToSrc(file);
      if (rel.endsWith('shared/validators/slug.ts')) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      const calls = code.match(/assertChangedSlugLength\(/g)?.length ?? 0;
      if (calls > 0) counts[rel] = calls;
    }

    expect(counts).toEqual(
      Object.fromEntries(Object.entries(WRITERS).map(([file, { calls }]) => [file, calls])),
    );
  });
});
