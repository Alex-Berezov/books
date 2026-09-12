import { Reflector } from '@nestjs/core';
import type { CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { PublicCacheInterceptor } from './public-cache.interceptor';
import { DEGRADED_RESPONSE, markDegraded } from './degraded-response';
import {
  createExecutionContextStub,
  createResponseStub,
  type ResponseStub,
} from '../testing/response-stub';

const nextHandler = { handle: () => of(null) };

describe('PublicCacheInterceptor', () => {
  const run = (isPersonal: boolean, response: ResponseStub) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPersonal);
    new PublicCacheInterceptor(reflector).intercept(
      createExecutionContextStub(response),
      nextHandler,
    );
  };

  describe('персональный ответ', () => {
    it('объявляет Vary: Authorization, а не только no-store', () => {
      // Второй рубеж: `no-store` говорит «не храни», `Vary` — «если хранишь,
      // различай». Без него снятие `@NoPublicCache` сразу отдаёт общему кэшу
      // право раздать личный ответ всем (`LEGACY-088` через кэш).
      const response = createResponseStub();
      run(true, response);

      expect(response.headers['Cache-Control']).toBe('private, no-store');
      expect(response.headers['Vary']).toBe('Authorization');
    });

    it('не затирает Vary, поставленный CORS', () => {
      // `Origin` ставит CORS. Потеря его развалила бы раздачу ответов разным
      // источникам — ради этого и берётся `res.vary()` вместо `setHeader`.
      const response = createResponseStub({ Vary: 'Origin' });
      run(true, response);

      expect(response.headers['Vary']).toBe('Origin, Authorization');
    });
  });

  describe('публичный ответ', () => {
    it('остаётся кэшируемым и не получает Authorization в Vary', () => {
      // Публичный ответ от токена не зависит; объявить обратное значило бы
      // расщепить общий кэш надвое без причины.
      const response = createResponseStub({ Vary: 'Origin' });
      run(false, response);

      expect(response.headers['Cache-Control']).toBe(
        'public, s-maxage=300, stale-while-revalidate=3600',
      );
      expect(response.vary).not.toHaveBeenCalledWith('Authorization');
      expect(String(response.headers['Vary'])).not.toContain('Authorization');
    });

    /**
     * 🔴 `LEGACY-107`. Язык публичного ответа берётся из заголовка, когда его
     * нет в запросе явно (`language.util.ts:55-62`), — и маршруты под `/:lang/`
     * от этого не свободны: язык пути отбрасывается, если книга на нём не
     * издана, и выбор снова уходит к заголовку (`book.service.ts:324-328`).
     * Общий кэш ключует по URL, поэтому без этого поля первый пришедший
     * определяет язык `title`, `description`, `canonical` и OG-разметки
     * для всех остальных на 300 секунд и до часа `stale-while-revalidate`.
     */
    it('объявляет Vary: Accept-Language', () => {
      const response = createResponseStub();
      run(false, response);

      expect(response.headers['Vary']).toBe('Accept-Language');
    });

    it('не затирает Vary, поставленный CORS', () => {
      const response = createResponseStub({ Vary: 'Origin' });
      run(false, response);

      expect(response.headers['Vary']).toBe('Origin, Accept-Language');
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
describe('PublicCacheInterceptor — отказ публичного маршрута', () => {
  /**
   * 🔴 Заголовок ставится в фазе «до», то есть раньше пайпов и обработчика,
   * и на исключении уезжает вместе с ответом. Без снятия общий кэш держал бы
   * 404 и 500 публичного маршрута пять минут плюс час
   * `stale-while-revalidate` — база поднялась бы через секунду, а ошибка
   * раздавалась бы час.
   */
  const runFailing = async (isPersonal: boolean, response: ResponseStub): Promise<unknown> => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPersonal);
    const handler: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    return new Promise((resolve) => {
      new PublicCacheInterceptor(reflector)
        .intercept(createExecutionContextStub(response), handler)
        .subscribe({ error: resolve });
    });
  };

  it('публичный кэш снимается с отказа', async () => {
    const response = createResponseStub();

    await runFailing(false, response);

    expect(response.headers['Cache-Control']).toBe('private, no-store');
  });

  it('исключение не проглатывается', async () => {
    const response = createResponseStub();

    const error = await runFailing(false, response);

    expect((error as Error).message).toBe('boom');
  });

  it('персональный отказ остаётся приватным', async () => {
    const response = createResponseStub();

    await runFailing(true, response);

    expect(response.headers['Cache-Control']).toBe('private, no-store');
  });
});

describe('PublicCacheInterceptor — деградировавший ответ', () => {
  const runWithValue = (isPersonal: boolean, response: ResponseStub, value: unknown) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPersonal);
    const handler: CallHandler = { handle: () => of(value) };
    let emitted: unknown;
    new PublicCacheInterceptor(reflector)
      .intercept(createExecutionContextStub(response), handler)
      .subscribe((v) => {
        emitted = v;
      });
    return emitted;
  };

  it('помеченный ответ получает короткий кэш вместо пятиминутного', () => {
    const response = createResponseStub();

    runWithValue(false, response, markDegraded({ meta: { title: 'x' } }));

    expect(response.headers['Cache-Control']).toBe('public, s-maxage=10');
  });

  it('обычный ответ остаётся на штатном кэше', () => {
    const response = createResponseStub();

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
    const response = createResponseStub();
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
    const response = createResponseStub();

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
