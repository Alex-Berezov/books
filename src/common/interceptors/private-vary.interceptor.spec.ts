import { lastValueFrom, of } from 'rxjs';
import { PrivateVaryInterceptor } from './private-vary.interceptor';
import {
  createExecutionContextStub,
  createResponseStub,
  passthroughHandler,
  type ResponseStub,
} from '../testing/response-stub';

/** Прогон до конца: второй рубеж ставится в фазе «после», то есть в `map`. */
const run = async (response: ResponseStub): Promise<void> => {
  await lastValueFrom(
    new PrivateVaryInterceptor().intercept(
      createExecutionContextStub(response),
      passthroughHandler,
    ),
  );
};

describe('PrivateVaryInterceptor', () => {
  describe('второй рубеж приватного ответа (LEGACY-101)', () => {
    /**
     * Сам `Cache-Control` к этому моменту уже стоит: его ставит
     * `DefaultCacheControlMiddleware` до гвардов. Интерцептор отвечает только
     * за `Vary`.
     */
    it('приватный ответ получает Vary: Authorization', async () => {
      const response = createResponseStub({ 'Cache-Control': 'private, no-store' });

      await run(response);

      expect(response.headers['Vary']).toBe('Authorization');
    });

    it('не затирает Vary, поставленный CORS', async () => {
      const response = createResponseStub({ 'Cache-Control': 'private, no-store', Vary: 'Origin' });

      await run(response);

      expect(response.headers['Vary']).toBe('Origin, Authorization');
    });

    /**
     * 🔴 Установки `Cache-Control` здесь быть не должно вовсе: две копии одной
     * политики расходятся молча. Заголовок ставит middleware.
     */
    it('сам Cache-Control не ставит', async () => {
      const response = createResponseStub();

      await run(response);

      expect(response.setHeader).not.toHaveBeenCalled();
      expect(response.headers['Cache-Control']).toBeUndefined();
    });
  });

  describe('чужой заголовок не трогается', () => {
    /**
     * `@Header('Cache-Control', 'public, max-age=3600')` у
     * `rights-agent.controller.ts:53,61` применяется до интерцепторов. Публичный
     * ответ от токена не зависит, и `Authorization` в `Vary` ему не нужен.
     */
    it('публичный @Header() переживает интерцептор и Authorization в Vary не получает', async () => {
      const response = createResponseStub({ 'Cache-Control': 'public, max-age=3600' });

      await run(response);

      expect(response.headers['Cache-Control']).toBe('public, max-age=3600');
      expect(response.vary).not.toHaveBeenCalled();
    });

    /**
     * Заголовок, выставленный вручную в другой приватной форме
     * (`rights-files.controller.ts:237`), второй рубеж получить обязан:
     * сравнение со строкой целиком пропустило бы его мимо.
     */
    it('чужая приватная форма сохраняется и получает Vary: Authorization', async () => {
      const response = createResponseStub({
        'Cache-Control': 'private, max-age=0, must-revalidate',
      });

      await run(response);

      expect(response.headers['Cache-Control']).toBe('private, max-age=0, must-revalidate');
      expect(response.headers['Vary']).toBe('Authorization');
    });
  });

  describe('ответ, отданный обработчиком самостоятельно', () => {
    /**
     * 🔴 Шесть обработчиков заканчивают ответ сами — `@Res()` без `passthrough`
     * и синхронный `res.send()`/`res.end()`: `sitemap.controller.ts`
     * (`robots.txt`, `sitemap.xml`, `sitemap-:lang.xml`) и три выгрузки
     * в `rights-files.controller.ts`. Nest выполняет интерцепторы и при уже
     * отданном ответе — пустым становится только `fnHandleResponse`.
     *
     * Без этой проверки `vary()` зовёт `setHeader` на закрытом ответе и бросает
     * `ERR_HTTP_HEADERS_SENT`. Клиент к тому моменту уже получил тело, поэтому
     * по коду ответа дефект невидим: он виден только потоком событий в Sentry
     * с каждого захода краулера на `robots.txt`.
     */
    it('заголовков не трогает, когда ответ уже отдан', async () => {
      const response = createResponseStub({ 'Cache-Control': 'private, no-store' }, true);

      await run(response);

      expect(response.vary).not.toHaveBeenCalled();
      expect(response.headers['Vary']).toBeUndefined();
    });
  });

  describe('решение PublicCacheInterceptor не откатывается (LEGACY-101)', () => {
    /**
     * Глобальный интерцептор идёт в цепочке Nest **перед** контроллерным,
     * поэтому к фазе «после» заголовок уже несёт решение `PublicCacheInterceptor`.
     * Публичный ответ от токена не зависит, и приписка `Authorization`
     * расщепила бы общий кэш надвое без причины.
     */
    it('публичный ответ, объявленный позже по цепочке, Authorization в Vary не получает', async () => {
      const response = createResponseStub();

      await lastValueFrom(
        new PrivateVaryInterceptor().intercept(createExecutionContextStub(response), {
          handle: () => {
            // Ровно то, что делает PublicCacheInterceptor в своей фазе «до».
            response.setHeader(
              'Cache-Control',
              'public, s-maxage=300, stale-while-revalidate=3600',
            );
            return of(null);
          },
        }),
      );

      expect(response.headers['Cache-Control']).toBe(
        'public, s-maxage=300, stale-while-revalidate=3600',
      );
      expect(response.vary).not.toHaveBeenCalled();
    });
  });
});
