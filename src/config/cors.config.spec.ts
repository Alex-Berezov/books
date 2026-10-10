import { readFileSync } from 'fs';
import { join } from 'path';
import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, getCorsConfig } from './cors.config';

/**
 * `LEGACY-270`. Слияние прогресса чтения на фронте сравнивает локальную отметку
 * времени (часы браузера) с серверной (часы базы) и поправляет её на расхождение
 * часов. Расхождение снимается с заголовка `Date` ответа — а браузер отдаёт коду
 * страницы только safelisted-заголовки, и `Date` в их число не входит. Значит
 * весь механизм на той стороне держится на одной строке здесь.
 *
 * 🔴 Посадка нужна именно потому, что отказ молчаливый: убери `Date` из списка —
 * фронтовые тесты останутся зелёными (msw ставит заголовок сам и CORS не
 * моделирует), а у читателя поправка станет нулевой и телефон с неточными часами
 * снова начнёт выигрывать каждое слияние устаревшей записью.
 */
describe('CORS: состав exposedHeaders', () => {
  const originalOrigin = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (originalOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = originalOrigin;
    }
  });

  it('отдаёт Date и Age наружу — на них держится поправка часов во фронте', () => {
    expect(CORS_EXPOSED_HEADERS).toContain('Date');
    expect(CORS_EXPOSED_HEADERS).toContain('Age');
  });

  it('не теряет заголовки лимитера, которые отдавались и раньше', () => {
    expect(CORS_EXPOSED_HEADERS).toContain('X-RateLimit-Limit');
    expect(CORS_EXPOSED_HEADERS).toContain('X-RateLimit-Remaining');
    expect(CORS_EXPOSED_HEADERS).toContain('X-RateLimit-Reset');
  });

  /**
   * 🔴 Обе ветки, а не одна. Ветка с `origin: '*'` работает в разработке и до
   * 06.09.2026 не отдавала наружу ничего вовсе: заголовок, забытый в ней, даёт
   * отказ, который воспроизводится только локально.
   */
  it('список один и тот же при подстановочном источнике и при явных', () => {
    process.env.CORS_ORIGIN = '*';
    expect(getCorsConfig().exposedHeaders).toEqual(CORS_EXPOSED_HEADERS);

    process.env.CORS_ORIGIN = 'https://bibliaris.com';
    expect(getCorsConfig().exposedHeaders).toEqual(CORS_EXPOSED_HEADERS);
  });
});

/**
 * `LEGACY-372`. Разовый токен прямой загрузки читается **только** заголовком
 * `X-Upload-Token` (`modules/uploads/uploads.controller.ts`), а запрос кросс-доменный
 * и с `Content-Type: audio/mpeg`, то есть браузер обязательно шлёт предзапрос.
 *
 * 🔴 Посадка нужна потому, что отказ невидим со стороны сервера: без заголовка в списке
 * браузер тело не отправляет вовсе — ни 401, ни 413, ни строчки в логе. Фронтовые тесты
 * этого тоже не покажут: `msw` и заглушка XHR предзапрос не моделируют.
 */
describe('CORS: состав allowedHeaders', () => {
  const originalOrigin = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalOrigin;
  });

  it('принимает X-Upload-Token — без него прямая загрузка не доезжает до сервера', () => {
    expect(CORS_ALLOWED_HEADERS).toContain('X-Upload-Token');
  });

  it('не теряет заголовки, которые принимались и раньше', () => {
    for (const header of [
      'Content-Type',
      'Authorization',
      'X-Admin-Language',
      'Accept-Language',
      'Accept',
      'Origin',
      'X-Requested-With',
    ]) {
      expect(CORS_ALLOWED_HEADERS).toContain(header);
    }
  });

  /**
   * 🔴 Обе ветки, а не одна: до 10.09.2026 списка было два, и ветка с `origin: '*'`
   * (та, что работает в разработке) знала на три заголовка меньше.
   */
  it('список один и тот же при подстановочном источнике и при явных', () => {
    process.env.CORS_ORIGIN = '*';
    expect(getCorsConfig().allowedHeaders).toEqual(CORS_ALLOWED_HEADERS);

    process.env.CORS_ORIGIN = 'https://bibliaris.com';
    expect(getCorsConfig().allowedHeaders).toEqual(CORS_ALLOWED_HEADERS);
  });
});

/**
 * Заголовки предзапроса на боевой машине отдаёт **только** Nest: в копии живого конфига
 * `configs/Caddyfile.prod` директивы `Access-Control-Allow-Headers` нет вовсе (там объявлен
 * один `Access-Control-Allow-Credentials`). Поэтому `X-Upload-Token` заработал в проде
 * от правки `CORS_ALLOWED_HEADERS`, без единого касания Caddy (`LEGACY-372`).
 *
 * 🔴 Стеречь надо ровно это. Директива `header` в Caddy значение апстрима **заменяет**,
 * а не дополняет: стоит появиться в конфиге своей строке `Access-Control-Allow-Headers`,
 * и она молча снимет любой заголовок, добавленный в коде, - браузер зарубит запрос
 * на предзапросе, и на сервере не останется ни строчки лога. Спека краснеет на само
 * появление такой строки и требует, чтобы список в ней совпал с кодом.
 *
 * Скрипт `apply-api-subdomain.sh`, переписывавший `/etc/caddy/Caddyfile` целиком, удалён
 * 03.10.2026 (`LEGACY-054`); живой конфиг `Access-Control-Allow-Headers` не задаёт.
 */
describe('CORS: копия списка заголовков в конфиге Caddy', () => {
  const caddyPath = join(__dirname, '../../configs/Caddyfile.prod');

  it('копия живого конфига своего списка заголовков не объявляет, а объявит - совпадает с кодом', () => {
    const caddy = readFileSync(caddyPath, 'utf8');

    // Сначала - что читается тот самый файл и тот самый блок. Без этой строки спека
    // зеленела бы и на пустом, и на переименованном конфиге: «списка нет» тогда значит
    // «я ничего не нашла», а не «его там нет».
    expect(caddy).toContain('Access-Control-Allow-Credentials');

    const line = caddy.match(/Access-Control-Allow-Headers\s+"([^"]+)"/);

    if (line === null) {
      // Исход «сверять было нечего» назван отдельно, а не молчаливым `return`: зелёная строка
      // без единой проверки неотличима от «списки совпали» (`L-015`). Сегодня строки в конфиге
      // нет вовсе - это и есть проверяемое утверждение.
      expect(caddy).not.toContain('Access-Control-Allow-Headers');
      return;
    }

    const inCaddy = line[1].split(',').map((name) => name.trim());
    expect([...inCaddy].sort()).toEqual([...CORS_ALLOWED_HEADERS].sort());
  });
});

/**
 * `LEGACY-455`: чужой Origin получал 500 — ошибка из `cors` без `status` у обработчика Express
 * означает сбой сервера, и каждый запрос с чужой страницы шумел в метриках как авария.
 * Отказ остаётся отказом (403), а не пропуском без заголовков: простой кросс-доменный запрос
 * до ручки доходить не должен.
 */
describe('CORS: чужой Origin', () => {
  const originalOrigin = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (originalOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalOrigin;
  });

  function app() {
    process.env.CORS_ORIGIN = 'https://bibliaris.com';
    const reached = jest.fn();
    const server = express();
    server.use(cors(getCorsConfig()));
    server.post('/views', (_req, res) => {
      reached();
      res.json({ ok: true });
    });
    return { server, reached };
  }

  it('403, а не 500, и ручка не выполняется', async () => {
    const { server, reached } = app();
    const res = await request(server).post('/views').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(reached).not.toHaveBeenCalled();
  });

  it('свой Origin и запрос без Origin проходят', async () => {
    const { server, reached } = app();
    const own = await request(server).post('/views').set('Origin', 'https://bibliaris.com');
    expect(own.status).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBe('https://bibliaris.com');
    await request(server).post('/views').expect(200);
    expect(reached).toHaveBeenCalledTimes(2);
  });
});
