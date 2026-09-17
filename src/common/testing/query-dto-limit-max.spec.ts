import { getMetadataStorage } from 'class-validator';
import { listDtoFiles, relativeToSrc } from './controller-decorators';

/**
 * Сторож «у каждого входного DTO с полем `limit` есть потолок `@Max`» (`LEGACY-377`).
 *
 * Потолок, заданный `Math.min` в сервисе, не доезжает ни до OpenAPI, ни до 400 на входе:
 * клиент получает 200 и молча урезанную страницу. Без потолка вовсе `?limit=100000`
 * уходит в `take` как есть.
 *
 * ⚠️ Проверка идёт по метаданным class-validator, а не по тексту файла: текстовый сторож
 * принимает за декоратор комментарий и не видит потолка, унаследованного от
 * `PaginationDto` (`ListCommentsQueryDto` переобъявляет `limit` через `declare`).
 * Входным считается класс, у которого на `limit` висит хоть один валидатор: DTO ответа
 * описаны только Swagger-декораторами и сюда не попадают.
 */

/** Ниже этого числа сломан обход или импорт, а не поредел репозиторий. */
const MIN_LIMIT_DTOS = 20;

type ClassRef = abstract new (...args: never[]) => unknown;

const exportedClasses = (file: string): Array<{ name: string; ref: ClassRef }> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- DTO грузятся по списку файлов, статический импорт невозможен
  const exports = require(file) as Record<string, unknown>;
  return Object.entries(exports)
    .filter((entry): entry is [string, ClassRef] => typeof entry[1] === 'function')
    .map(([name, ref]) => ({ name, ref }));
};

describe('every input DTO with a limit field has a @Max ceiling', () => {
  const storage = getMetadataStorage();
  const checked: string[] = [];
  const uncapped: string[] = [];

  for (const file of listDtoFiles()) {
    for (const { name, ref } of exportedClasses(file)) {
      const limitRules = storage
        .getTargetValidationMetadatas(ref, '', true, false)
        .filter((meta) => meta.propertyName === 'limit');
      if (limitRules.length === 0) continue;

      const where = `${relativeToSrc(file)} → ${name}`;
      checked.push(where);
      if (!limitRules.some((meta) => meta.name === 'max')) uncapped.push(where);
    }
  }

  it(`finds at least ${MIN_LIMIT_DTOS} input DTOs with limit`, () => {
    expect(checked.length).toBeGreaterThanOrEqual(MIN_LIMIT_DTOS);
  });

  it('has no input DTO whose limit lacks @Max', () => {
    expect(uncapped).toEqual([]);
  });
});
