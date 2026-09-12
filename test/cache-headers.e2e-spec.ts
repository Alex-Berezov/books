import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';

/**
 * Живые кэш-заголовки (`LEGACY-107`, `LEGACY-108`, `LEGACY-174`).
 *
 * 🔴 Проверять надо пробой заголовков живого маршрута, а не наличием
 * декоратора: `LEGACY-108` нашли именно живой пробой прода 11.08.2026 —
 * обход по коду её не показывал. Юниты интерцепторов говорят, что каждый
 * из них решает правильно; здесь проверяется, что цепочка Nest складывает
 * два решения в тот заголовок, который уходит клиенту.
 */
describe('кэш-заголовки живых ответов', () => {
  let app: INestApplication;
  let token: string;

  const http = () => httpServerOf(app);

  beforeAll(async () => {
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    const registered = await request(http())
      .post('/auth/register')
      .send({ email: `cache_${Date.now()}@example.com`, password: 'password123' })
      .expect(201);
    token = (registered.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('личный кабинет закрыт от общего кэша (LEGACY-108)', () => {
    /**
     * До 12.09.2026 эти маршруты уходили **без `Cache-Control` вовсе**:
     * `PublicCacheInterceptor` висел на 23 обработчиках из 317, а глобального
     * умолчания не было. Отсутствие директив — не нейтральное состояние:
     * по RFC 9111 §4.2.2 общий кэш вправе хранить такой ответ эвристически.
     */
    it.each([['/users/me'], ['/users/me/activities'], ['/me/bookshelf']])(
      '%s отвечает private, no-store и объявляет Vary: Authorization',
      async (path) => {
        const response = await request(http())
          .get(path)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(String(response.headers['vary'])).toContain('Authorization');
      },
    );

    /**
     * Отказ кэшировать нельзя: `LEGACY-104` наблюдала `s-maxage` и на 401.
     * Заголовок ставится в фазе «до», поэтому путь, кончающийся исключением,
     * его тоже получает.
     */
    it('401 без токена тоже не кэшируется', async () => {
      const response = await request(http()).get('/users/me').expect(401);

      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    /**
     * ⚠️ Кейса на 404 несуществующего маршрута здесь нет намеренно.
     * `e2e-route-existence.spec.ts` (`LEGACY-024`) запрещает e2e ходить по
     * путям, которых нет среди объявленных маршрутов, — и заводить ему
     * исключение ради одной проверки значило бы ослабить сторож, написанный
     * ровно против спек «по маршрутам из памяти».
     *
     * Охват несуществующих путей держит вместо этого кейс
     * `DefaultCacheControlMiddleware применён ко всем маршрутам`
     * в `src/common/testing/cache-headers-wiring.spec.ts`: он фиксирует шаблон
     * `{*path}`, и сужение шаблона краснеет там.
     */
  });

  describe('гео-зависимый ответ не попадает в общий кэш (LEGACY-174)', () => {
    /**
     * Тело этих маршрутов зависит от страны запроса: та же ссылка даёт либо
     * контент, либо 451 (`geo-block-rule.service.ts:276`). Общий кэш ключует
     * по URL, поэтому ответ, собранный для разрешённой страны, раздавался бы
     * в заблокированные — правовой инцидент, а не деградация.
     *
     * Запись предпочитает приватный ответ гео-оси в `Vary`: ключ по стране
     * размножает кэш и всё равно не защищает от расхождения источников
     * заголовка (`LEGACY-172`).
     *
     * ⚠️ Эти четыре кейса проверяют **глобальное умолчание**, а не саму
     * гео-ветку: нулевой идентификатор даёт 404 раньше, чем дело дойдёт до
     * `assertAccess`. Связь маршрута с гео-проверкой держит не этот файл,
     * а список `PUBLIC_CACHE_HANDLERS` в
     * `src/common/testing/cache-headers-wiring.spec.ts`: пока ни один
     * обработчик с `assertAccess` в него не входит, публичного кэша им
     * не достаётся. Вписанный туда гео-обработчик пройдёт мимо обоих сторожей —
     * это остаток, названный в теле `LEGACY-174`.
     */
    it.each([
      ['/versions/00000000-0000-0000-0000-000000000000/chapters'],
      ['/versions/00000000-0000-0000-0000-000000000000/audio-chapters'],
      ['/chapters/00000000-0000-0000-0000-000000000000'],
      ['/audio-chapters/00000000-0000-0000-0000-000000000000'],
    ])('%s не объявляет себя публично кэшируемым', async (path) => {
      const response = await request(http()).get(path);

      expect(String(response.headers['cache-control'])).not.toContain('public');
      expect(String(response.headers['cache-control'])).toContain('no-store');
    });
  });

  describe('обработчики, отдающие ответ сами (@Res без passthrough)', () => {
    /**
     * 🔴 `sitemap.controller.ts` и три выгрузки в `rights-files.controller.ts` —
     * единственные шесть мест, где ответ закрывается вручную. Интерцепторы Nest
     * при этом всё равно выполняются, поэтому любой глобальный интерцептор,
     * трогающий заголовки в фазе «после», бросает на них
     * `ERR_HTTP_HEADERS_SENT`.
     *
     * Проверяется именно лог ошибки, а не код ответа: тело уезжает клиенту
     * до броска, поэтому `expect(200)` зелёный в обоих случаях — и с дефектом,
     * и без него. Ровно поэтому дефект и не поймали ни `sitemap.e2e-spec.ts`,
     * ни `rights-file-storage.e2e-spec.ts`.
     */
    /**
     * 🔴 Публичный кэш здесь доказывается **прогоном**, а не чтением кода:
     * обработчик отдаёт ответ сам, и вопрос «успевает ли интерцептор поставить
     * заголовок до `res.send()`» решается только живым запросом.
     * До 12.09.2026 своего `Cache-Control` у этих документов не было вовсе,
     * а после инверсии умолчания они получали `private, no-store` — неверно
     * по смыслу: карта сайта одинакова для всех.
     */
    it.each([['/robots.txt'], ['/sitemap.xml'], ['/sitemap-en.xml']])(
      '%s объявлен публично кэшируемым',
      async (path) => {
        const response = await request(http()).get(path).expect(200);

        expect(response.headers['cache-control']).toContain('public');
        expect(String(response.headers['cache-control'])).not.toContain('no-store');
      },
    );

    /**
     * 🔴 Отказ публичного маршрута публичным кэшем не объявляется. Заголовок
     * ставится в фазе «до», раньше пайпов, поэтому без снятия 404 уезжал бы
     * с `public, s-maxage=300`, и общий кэш держал бы его пять минут плюс час
     * `stale-while-revalidate`. Язык `de` в перечислении отсутствует, поэтому
     * `LangParamPipe` отвечает отказом.
     */
    it('404 карты сайта не объявляется публично кэшируемым', async () => {
      const response = await request(http()).get('/sitemap-de.xml');

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(String(response.headers['cache-control'])).not.toContain('public');
    });

    it.each([['/robots.txt'], ['/sitemap.xml'], ['/sitemap-en.xml']])(
      '%s отдаётся без ошибки записи в закрытый ответ',
      async (path) => {
        const logged: string[] = [];
        const spy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation((...args: unknown[]) => {
            logged.push(args.map((a) => String(a)).join(' '));
          });

        try {
          await request(http()).get(path).expect(200);
        } finally {
          spy.mockRestore();
        }

        expect(logged.join(' | ')).not.toContain('ERR_HTTP_HEADERS_SENT');
        expect(logged.join(' | ')).not.toContain('Cannot set headers');
      },
    );
  });

  describe('публичный кэш сохранён там, где он и был', () => {
    /**
     * Правка переворачивает умолчание, а не снимает публичный кэш: глобальный
     * интерцептор идёт в цепочке перед контроллерным, поэтому решение
     * `PublicCacheInterceptor` остаётся последним.
     */
    it('публичный список отдаётся с публичным кэшем и без Authorization в Vary', async () => {
      const response = await request(http()).get('/en/books/cards?limit=1').expect(200);

      expect(response.headers['cache-control']).toContain('public');
      expect(String(response.headers['vary'])).not.toContain('Authorization');
    });

    /**
     * 🔴 `LEGACY-107`. Язык публичного ответа берётся из заголовка, когда его
     * нет в запросе явно. Без этого поля первый пришедший определял бы язык
     * разметки для всех остальных на 300 секунд.
     */
    it('публичный ответ объявляет Vary: Accept-Language', async () => {
      const response = await request(http()).get('/en/books/cards?limit=1').expect(200);

      expect(String(response.headers['vary'])).toContain('Accept-Language');
    });
  });
});
