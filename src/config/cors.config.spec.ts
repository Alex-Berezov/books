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
