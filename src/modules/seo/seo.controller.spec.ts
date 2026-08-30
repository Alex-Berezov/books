import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { BadRequestException } from '@nestjs/common';
import { SeoController } from './seo.controller';

/**
 * 🔴 `LEGACY-319`. До 30.08.2026 список типов страниц `/seo/resolve` был выписан
 * руками четырежды — по `@ApiQuery` и по массиву `allowed` на каждый из двух
 * обработчиков, — и две копии уже разошлись: документация первого обработчика
 * не знала `collection`, который рантайм принимал. Не ловило это ничто: оба
 * списка литералы, компилятору сверять нечего.
 *
 * ⚠️ Ожидаемый список выписан здесь руками намеренно. Взять его из того же
 * `Object.values(ResolveSeoType)`, откуда его берёт код, значило бы сверить
 * объект сам с собой — проверка, не способная покраснеть (`L-015`, `L-016`,
 * `L-017`). Список из восьми значений — это утверждение о контракте ручки,
 * и меняться он должен вместе с этой строкой, а не молча.
 */
describe('SeoController: тип страницы описан там же, где проверяется (LEGACY-319)', () => {
  const EXPECTED_TYPES = [
    'book',
    'version',
    'page',
    'category',
    'genre',
    'tag',
    'catalog',
    'collection',
  ];

  const readApiQueryTypeEnum = (method: 'resolve' | 'resolveWithLang'): unknown[] => {
    const params: Array<Record<string, unknown>> =
      Reflect.getMetadata(DECORATORS.API_PARAMETERS, SeoController.prototype[method]) ?? [];
    const typeParam = params.find((p) => p.name === 'type' && p.in === 'query');
    if (!typeParam) {
      throw new Error(`@ApiQuery({ name: 'type' }) не найден у обработчика ${method}`);
    }
    // Swagger кладёт перечисление не в сам параметр, а в его `schema`.
    const schema = typeParam.schema as { enum?: unknown[] } | undefined;
    if (!schema?.enum) {
      throw new Error(`У @ApiQuery({ name: 'type' }) обработчика ${method} нет перечисления`);
    }
    return schema.enum;
  };

  // Страховка от «проверено ноль единиц»: если рефлексия перестанет что-либо
  // отдавать, сравнение с пустотой ниже прошло бы молча.
  it.each(['resolve', 'resolveWithLang'] as const)(
    'у обработчика %s перечисление типа читается из метаданных и непусто',
    (method) => {
      const values = readApiQueryTypeEnum(method);
      expect(Array.isArray(values)).toBe(true);
      expect(values.length).toBeGreaterThan(0);
    },
  );

  it.each(['resolve', 'resolveWithLang'] as const)(
    'документация обработчика %s перечисляет ровно те типы, что принимает ручка',
    (method) => {
      expect([...readApiQueryTypeEnum(method)].sort()).toEqual([...EXPECTED_TYPES].sort());
    },
  );

  describe('рантайм принимает ровно тот же список', () => {
    const service = { resolvePublic: jest.fn().mockResolvedValue({}) };
    const controller = new SeoController(service as never, {} as never, {} as never, {} as never);

    beforeEach(() => service.resolvePublic.mockClear());

    // `collection` — то самое значение, которого не было в документации первого
    // обработчика. Если список снова разъедется в эту сторону, красным станет
    // тест выше; этот стережёт вторую сторону — что значение реально проходит.
    it('type=collection доходит до сервиса, а не отбивается как невалидный', async () => {
      await controller.resolve('collection', 'some-slug');
      expect(service.resolvePublic).toHaveBeenCalledTimes(1);
      expect(service.resolvePublic).toHaveBeenCalledWith(
        'collection',
        'some-slug',
        expect.anything(),
      );
    });

    // `author` есть в словаре канонических адресов (`CanonicalPathType`), но
    // ручкой не принимается. Проверка стережёт границу двух словарей: слияние
    // их в один протащило бы `author` сюда.
    it('type=author отбивается 400, хотя такой вид пути существует', () => {
      expect(() => controller.resolve('author', 'some-slug')).toThrow(BadRequestException);
      expect(service.resolvePublic).not.toHaveBeenCalled();
    });
  });
});
