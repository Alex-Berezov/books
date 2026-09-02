import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { AuthorController } from './author.controller';

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
