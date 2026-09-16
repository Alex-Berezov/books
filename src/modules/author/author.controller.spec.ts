import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { Language } from '@prisma/client';
import { AuthorController } from './author.controller';
import type { AuthorService } from './author.service';

/**
 * `LEGACY-217`, третья часть: пять маршрутов файла закрыты `JwtAuthGuard`
 * и `RolesGuard`, а Swagger до 01.09.2026 рисовал их открытыми - `@ApiBearerAuth()`
 * не стоял ни на классе, ни на одном методе.
 *
 * Проверяется метаданное, а не текст файла: `@ApiBearerAuth()` на классе
 * действует на все методы, и файловая проверка не отличила бы её от декоратора,
 * поставленного на один метод из пяти.
 *
 * ⚠️ Сплошной проверки «все закрытые маршруты репозитория объявляют
 * `@ApiBearerAuth()`» здесь намеренно нет: сегодня она красная - декоратора
 * не хватает ещё одиннадцати контроллерам. Это `LEGACY-132`, пачка `B9`,
 * там же лежит и готовый сканер `common/testing/controller-decorators.ts`.
 */
describe('AuthorController, замок в документации (LEGACY-217)', () => {
  it('объявляет @ApiBearerAuth() на классе', () => {
    const security = Reflect.getMetadata(DECORATORS.API_SECURITY, AuthorController) as
      | unknown[]
      | undefined;

    expect(security).toBeDefined();
    expect(security).toEqual(expect.arrayContaining([{ bearer: [] }]));
  });
});

/**
 * LEGACY-370: без `suggestedSlug` форма создания автора не отличала занятый слаг
 * от свободного — ветка «занят» на фронте ждёт именно это поле.
 */
describe('AuthorController.checkSlug (LEGACY-370)', () => {
  const service = {
    checkSlugExists: jest.fn(),
    generateUniqueSuggestedSlug: jest.fn(),
  };
  const controller = new AuthorController(service as unknown as AuthorService);

  beforeEach(() => jest.clearAllMocks());

  it('отдаёт suggestedSlug и existingAuthor, когда слаг занят', async () => {
    service.checkSlugExists.mockResolvedValue({ authorId: 'auth1', slug: 'leo-tolstoy' });
    service.generateUniqueSuggestedSlug.mockResolvedValue('leo-tolstoy-2');

    const res = await controller.checkSlug({
      slug: 'leo-tolstoy',
      lang: Language.ru,
      excludeId: 'auth9',
    });

    expect(res).toEqual({
      exists: true,
      suggestedSlug: 'leo-tolstoy-2',
      existingAuthor: { id: 'auth1', slug: 'leo-tolstoy' },
    });
    expect(service.generateUniqueSuggestedSlug).toHaveBeenCalledTimes(1);
    expect(service.generateUniqueSuggestedSlug).toHaveBeenCalledWith(
      'leo-tolstoy',
      Language.ru,
      'auth9',
    );
  });

  it('не ищет подсказку, когда слаг свободен', async () => {
    service.checkSlugExists.mockResolvedValue(null);

    const res = await controller.checkSlug({ slug: 'leo-tolstoy', lang: Language.en });

    expect(res).toEqual({ exists: false });
    expect(service.generateUniqueSuggestedSlug).not.toHaveBeenCalled();
  });
});
