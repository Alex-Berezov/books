import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import vary from 'vary';
import { PublicCacheInterceptor } from './public-cache.interceptor';
import type { CallHandler, ExecutionContext } from '@nestjs/common';

type HeaderValue = string | string[] | number;

interface ResponseStub {
  headers: Record<string, HeaderValue>;
  setHeader: jest.Mock<void, [string, HeaderValue]>;
  getHeader: jest.Mock<HeaderValue | undefined, [string]>;
  vary: jest.Mock<void, [string]>;
}

/**
 * Заглушка ответа, у которой `vary()` — **настоящий** пакет `vary`, тот же, что
 * стоит за `res.vary()` в Express.
 *
 * Так проверяется решение интерцептора (кому дописывать поле), а не пересказ
 * семантики заголовка. Первая версия этого файла подменяла `vary` собственной
 * реализацией на 15 строк и проверяла её же — тесты были зелёные и не
 * доказывали ничего о продукте.
 */
const createResponse = (initial: Record<string, HeaderValue> = {}): ResponseStub => {
  const headers: Record<string, HeaderValue> = { ...initial };
  const carrier = {
    setHeader: (name: string, value: HeaderValue) => {
      headers[name] = value;
    },
    getHeader: (name: string) => headers[name],
  };
  return {
    headers,
    setHeader: jest.fn(carrier.setHeader),
    getHeader: jest.fn(carrier.getHeader),
    // Настоящий пакет `vary` — тот же, что стоит за `res.vary()` в Express.
    vary: jest.fn((field: string) => {
      vary(carrier as unknown as Parameters<typeof vary>[0], field);
    }),
  };
};

const createContext = (response: ResponseStub) =>
  ({
    switchToHttp: () => ({ getResponse: () => response }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const nextHandler: CallHandler = { handle: () => of(null) };

describe('PublicCacheInterceptor', () => {
  const run = (isPersonal: boolean, response: ResponseStub) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPersonal);
    new PublicCacheInterceptor(reflector).intercept(createContext(response), nextHandler);
  };

  describe('персональный ответ', () => {
    it('объявляет Vary: Authorization, а не только no-store', () => {
      // Второй рубеж: `no-store` говорит «не храни», `Vary` — «если хранишь,
      // различай». Без него снятие `@NoPublicCache` сразу отдаёт общему кэшу
      // право раздать личный ответ всем (`LEGACY-088` через кэш).
      const response = createResponse();
      run(true, response);

      expect(response.headers['Cache-Control']).toBe('private, no-store');
      expect(response.headers['Vary']).toBe('Authorization');
    });

    it('не затирает Vary, поставленный CORS', () => {
      // `Origin` ставит CORS. Потеря его развалила бы раздачу ответов разным
      // источникам — ради этого и берётся `res.vary()` вместо `setHeader`.
      const response = createResponse({ Vary: 'Origin' });
      run(true, response);

      expect(response.headers['Vary']).toBe('Origin, Authorization');
    });
  });

  describe('публичный ответ', () => {
    it('остаётся кэшируемым и не получает Authorization в Vary', () => {
      // Публичный ответ от токена не зависит; объявить обратное значило бы
      // расщепить общий кэш надвое без причины.
      const response = createResponse({ Vary: 'Origin' });
      run(false, response);

      expect(response.headers['Cache-Control']).toBe(
        'public, s-maxage=300, stale-while-revalidate=3600',
      );
      expect(response.vary).not.toHaveBeenCalled();
      expect(response.headers['Vary']).toBe('Origin');
    });
  });
});
