import { INestApplication, ValidationPipe } from '@nestjs/common';
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
     * 🔴 `LEGACY-104`. `PublicCacheInterceptor` на публичной ветке `Vary`
     * больше не дописывает — поле снято вместе с чтением заголовка: Cloudflare
     * игнорирует его без custom cache key, а честный общий кэш расщепил бы
     * по нему ключ на каждого посетителя.
     *
     * ⚠️ Утверждение именно «интерцептор ничего не добавил», а не «поля нет
     * вовсе». Здесь приложение поднято голым `createNestApplication()` без
     * CORS, поэтому `Vary` пуст; на проде `CORS_ORIGIN` — список источников,
     * значит `origin` в `getCorsConfig` это функция, и пакет `cors` ставит
     * `Vary: Origin` на каждом ответе. Форма `toBeUndefined()` была бы верна
     * только для тестового приложения и покраснела бы в день, когда e2e
     * начнут поднимать приложение через `setupSecurity`, ничего не изменив
     * в кэш-контуре.
     */
    it('публичный ответ не получает Vary от интерцептора', async () => {
      const response = await request(http()).get('/en/books/cards?limit=1').expect(200);

      const vary = response.headers['vary'];
      expect(vary === undefined ? 'Origin' : String(vary)).toBe('Origin');
    });

    /**
     * 🔴 `LEGACY-104`. То, ради чего снималась зависимость от заголовка: два
     * запроса по одному URL с разными `Accept-Language` обязаны дать
     * **одинаковое** тело.
     *
     * ⚠️ Маршрут выбран не любой публичный, а тот, где дефект жил.
     * `GET /seo/resolve` — единственный из трёх починенных, у которого языка
     * в пути нет вовсе, то есть до правки заголовок определял язык
     * единолично: `title`, `description`, `canonical`, OG-разметку и крошки.
     * Первая версия этого кейса ходила на `/en/books/cards`, а тот обработчик
     * заголовок не читал **никогда** — кейс оставался бы зелёным и после
     * полного отката правки, то есть не был посадкой вовсе (`L-004`).
     *
     * `type=catalog` взят потому, что эта ветка не читает базу совсем
     * (`seo.service.ts:1152`) — кейс не зависит ни от сида, ни от фикстур.
     */
    it('тело /seo/resolve не зависит от Accept-Language', async () => {
      const ru = await request(http())
        .get('/seo/resolve?type=catalog&id=catalog')
        .set('Accept-Language', 'ru-RU,ru;q=0.9')
        .expect(200);
      const es = await request(http())
        .get('/seo/resolve?type=catalog&id=catalog')
        .set('Accept-Language', 'es-ES,es;q=0.9')
        .expect(200);

      expect(JSON.stringify(ru.body)).toBe(JSON.stringify(es.body));

      // И это тело — то же самое, что у запроса вовсе без заголовка:
      // сравнение двух ответов между собой прошло бы и в случае, когда оба
      // одинаково уехали на язык, взятый откуда-то ещё.
      const bare = await request(http()).get('/seo/resolve?type=catalog&id=catalog').expect(200);
      expect(JSON.stringify(bare.body)).toBe(JSON.stringify(ru.body));
    });

    /**
     * 🔴 `LEGACY-104`. Второй из трёх починенных обработчиков — с языком
     * в пути. Он зависел от заголовка не напрямую, а через фильтр `available`:
     * язык пути отбрасывался, если сущность на нём не издана, и выбор уходил
     * к заголовку (`seo.service.ts:444-451`). Проверяется, что и здесь тело
     * определяется адресом.
     */
    it('тело /:lang/seo/resolve не зависит от Accept-Language', async () => {
      const ru = await request(http())
        .get('/en/seo/resolve?type=catalog&id=catalog')
        .set('Accept-Language', 'ru-RU,ru;q=0.9')
        .expect(200);
      const es = await request(http())
        .get('/en/seo/resolve?type=catalog&id=catalog')
        .set('Accept-Language', 'es-ES,es;q=0.9')
        .expect(200);

      expect(JSON.stringify(ru.body)).toBe(JSON.stringify(es.body));
    });

    /**
     * 🔴 Отказ публичного маршрута публичным кэшем не объявляется. Заголовок
     * ставится в фазе «до», раньше пайпов, поэтому без снятия в `catchError`
     * (`public-cache.interceptor.ts:90`) 404 уезжал бы с `public, s-maxage=300`,
     * и общий кэш держал бы его пять минут плюс час `stale-while-revalidate`.
     * Язык `de` в перечислении отсутствует, поэтому `LangParamPipe` отвечает отказом.
     *
     * До 13.09.2026 то же самое доказывал `GET /sitemap-de.xml`; маршрут снят
     * вместе с модулем карты сайта (`LEGACY-129`), а проверка осталась здесь —
     * на живом публичном маршруте с тем же пайпом. Юнит на заглушке ответа
     * (`public-cache.interceptor.spec.ts`) её не заменяет: в нём нет ни middleware,
     * ни фильтра исключений, то есть порядок «интерцептор раньше пайпа» им не виден.
     */
    it('404 публичного маршрута не объявляется публично кэшируемым', async () => {
      const response = await request(http()).get('/de/books/cards?limit=1');

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(String(response.headers['cache-control'])).not.toContain('public');
    });
  });
});
