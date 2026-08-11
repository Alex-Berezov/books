import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { ModuleMetadata } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';

/**
 * DI-smoke-проверка модуля (`LEGACY-019`).
 *
 * `RateLimitModule` не помечен `@Global()`: он экспортирует провайдер
 * `RATE_LIMITER`, и каждый модуль, чьи гварды его инжектят, обязан импортировать
 * его сам. Пропуск не видят ни линтер, ни typecheck, ни остальные спеки — те
 * создают классы через `new`. Ошибка вылезает только когда Nest строит
 * контейнер, то есть на bootstrap: 29.07.2026 одна забытая строка уронила 44 из
 * 45 e2e-сьютов и дала 14 000 строк лога вместо одной внятной причины.
 *
 * `compile()` поднимает контейнер, но не запускает lifecycle-хуки, поэтому
 * `PrismaService.onModuleInit()` не срабатывает и подключение к БД не
 * открывается: пропуск ловится за секунды вместо полного e2e-прогона.
 *
 * ⚠️ Пояснение живёт здесь, а не в каждой спеке. Четыре копии этого текста
 * разошлись бы при первой же правке — тот же класс дублирования, что записан в
 * `LEGACY-042`.
 *
 * @param name    имя сьюта, обычно имя модуля
 * @param imports что подать в тестовый контейнер: сам модуль и те `@Global()`
 *                модули приложения, которые в тесте глобальными не являются
 */
export const describeDiSmoke = (
  name: string,
  imports: () => NonNullable<ModuleMetadata['imports']>,
  hooks: { beforeEach?: () => void; afterEach?: () => void } = {},
): void => {
  describe(`${name} (DI)`, () => {
    let moduleRef: TestingModule | undefined;

    beforeEach(() => hooks.beforeEach?.());

    afterEach(async () => {
      await moduleRef?.close();
      moduleRef = undefined;
      hooks.afterEach?.();
    });

    it('строит контейнер — значит все зависимости гвардов видны модулю', async () => {
      moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ...imports()],
      }).compile();

      expect(moduleRef).toBeDefined();
    });
  });
};
