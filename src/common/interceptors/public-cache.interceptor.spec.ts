import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import vary from 'vary';
import { PublicCacheInterceptor } from './public-cache.interceptor';
import { DEGRADED_RESPONSE, markDegraded } from './degraded-response';
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

/**
 * 🔴 `LEGACY-305`. Ответ, собранный по неполным данным, и ответ, собранный по
 * полным, — разные ответы, и кэшировать их одинаково нельзя. Признак деградации
 * рождается в сервисе, то есть уже после того, как заголовок поставлен.
 *
 * ⚠️ Здесь обязательна ПОДПИСКА на результат: `map` без неё не исполняется
 * вовсе, и спека, только вызывающая `intercept`, зеленеет на любом дефекте.
 */
describe('PublicCacheInterceptor — деградировавший ответ', () => {
  const runWithValue = (isPersonal: boolean, response: ResponseStub, value: unknown) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPersonal);
    const handler: CallHandler = { handle: () => of(value) };
    let emitted: unknown;
    new PublicCacheInterceptor(reflector)
      .intercept(createContext(response), handler)
      .subscribe((v) => {
        emitted = v;
      });
    return emitted;
  };

  it('помеченный ответ получает короткий кэш вместо пятиминутного', () => {
    const response = createResponse();

    runWithValue(false, response, markDegraded({ meta: { title: 'x' } }));

    expect(response.headers['Cache-Control']).toBe('public, s-maxage=10');
  });

  it('обычный ответ остаётся на штатном кэше', () => {
    const response = createResponse();

    runWithValue(false, response, { meta: { title: 'x' } });

    expect(response.headers['Cache-Control']).toBe(
      'public, s-maxage=300, stale-while-revalidate=3600',
    );
  });

  /**
   * Метка служебная и дальше интерцептора не живёт: она не должна ни попасть
   * в тело ответа, ни пережить его.
   */
  it('снимает метку с отданного значения', () => {
    const response = createResponse();
    const bundle = markDegraded({ meta: { title: 'x' } });

    const emitted = runWithValue(false, response, bundle) as Record<symbol, unknown>;

    expect(emitted[DEGRADED_RESPONSE]).toBeUndefined();
    // Символ не сериализуется вовсе — тело ответа не меняется ни на байт.
    expect(JSON.parse(JSON.stringify(emitted))).toEqual({ meta: { title: 'x' } });
  });

  /**
   * `private, no-store` строже короткого публичного кэша, и понижать его
   * деградацией нельзя: маршрут помечен персональным по другой причине.
   */
  it('персональный ответ короткий публичный кэш не получает, но метку теряет', () => {
    const response = createResponse();

    const emitted = runWithValue(true, response, markDegraded({ meta: { title: 'x' } })) as Record<
      symbol,
      unknown
    >;

    expect(response.headers['Cache-Control']).toBe('private, no-store');
    // ⚠️ Метка снимается и здесь: она служебная, и объект с ней уехал бы
    // дальше по конвейеру — в логи и в чужие интерцепторы, — а снимать её
    // было бы уже некому.
    expect(emitted[DEGRADED_RESPONSE]).toBeUndefined();
  });
});
