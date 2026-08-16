import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';

/**
 * `LEGACY-201`. `GET /admin/authors` и `GET /admin/authors/check-slug` отвечали
 * на проде **404**: оба — двухсегментные литеральные пути, и их перехватывал
 * публичный `@Controller(':lang')`, чей модуль регистрировался выше
 * `AuthorModule`. `LangParamPipe` получал `lang = 'admin'` и бросал
 * `NotFoundException` — до гварда дело не доходило вовсе. `POST`, `PUT`
 * и `DELETE` тех же адресов работали: публичных ручек такой формы нет,
 * поэтому отказ был частичным и в глаза не бросался.
 *
 * 🔴 Ни `tsc`, ни линт, ни сборка этого не видят: приложение стартует со
 * сломанным порядком, Swagger показывает оба маршрута. Единственная настоящая
 * проверка — живой запрос, и она здесь.
 *
 * Набор устроен так, чтобы отличать четыре исхода, а не два:
 *
 * - **200 админским токеном** — маршрут дошёл до админского обработчика;
 * - **401 без токена** — маршрут существует и закрыт входом; именно этим
 *   «ручка ожила» отличается от «ручка по-прежнему не та», где был бы 404;
 * - **403 токеном без роли** — маршрут закрыт ещё и ролью. До этой правки ручка
 *   отдавала 404 всем подряд, то есть доступ к ней открылся именно сейчас;
 *   без этого случая снятие `RolesGuard` не покрасило бы ничего;
 * - **200 на публичной стороне** — перестановка модулей не убила `:lang/authors`.
 *   Без этого случая набор из одних ожиданий «не 404» не отличил бы починку
 *   от новой поломки.
 */
describe('Admin authors routing (e2e)', () => {
  let app: INestApplication;
  let adminToken: string;
  let readerToken: string;

  const http = () => httpServerOf(app);

  const registerOrLogin = async (email: string, password = 'password123'): Promise<string> => {
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) return (reg.body as { accessToken: string }).accessToken;
    // 409 — пользователь остался от прошлого прогона; любой другой код это уже
    // не «он уже есть», и молчаливый переход к логину превратил бы отказ
    // регистрации (400, 429 от лимитера, 500) в невнятный отказ логина.
    if (reg.status !== 409)
      throw new Error(`Unexpected register status for ${email}: ${reg.status}`);
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return (login.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    // Роль администратора выдаётся при регистрации по списку `ADMIN_EMAILS`,
    // а его читает `ConfigService` — значит переменная ставится до сборки модуля.
    const adminEmail = 'admin-authors-routing@test.com';
    process.env.ADMIN_EMAILS = adminEmail;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    adminToken = await registerOrLogin(adminEmail);
    // Обычный читатель: его почты нет в `ADMIN_EMAILS`, роли в `UserRole` он
    // не получает. Нужен, чтобы отличить «маршрут закрыт входом» от «маршрут
    // закрыт ролью» — без него снятие `RolesGuard` не красит ничего.
    readerToken = await registerOrLogin(`reader-authors-routing-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /admin/authors', () => {
    it('отдаёт админский список постранично, а не 404 от публичного маршрута', async () => {
      const response = await request(http())
        .get('/admin/authors')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const body = response.body as {
        data: unknown[];
        meta: { page: number; limit: number; total: number; totalPages: number };
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.page).toBe(1);
      // Размер страницы задан дефолтом `PaginationDto` (`limit = 10`), а не
      // запасным значением контроллера (`20`), до которого дело не доходит:
      // `transform: true` подставляет дефолт DTO раньше. Пинится точным
      // значением — «больше нуля» пропустило бы дефолт в тысячу строк.
      expect(body.meta.limit).toBe(10);
      expect(body.data.length).toBeLessThanOrEqual(10);
    });

    it('без токена отвечает 401 от гварда, а не 404 от чужого маршрута', async () => {
      await request(http()).get('/admin/authors').expect(401);
    });

    it('аутентифицированному без роли отвечает 403, а не отдаёт список', async () => {
      await request(http())
        .get('/admin/authors')
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(403);
    });
  });

  describe('GET /admin/authors/check-slug', () => {
    it('сообщает, что заведомо свободный слаг свободен', async () => {
      const response = await request(http())
        .get('/admin/authors/check-slug')
        .query({ slug: `free-author-slug-${Date.now()}` })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({ exists: false });
    });

    // Ветка «слаг занят» — вторая половина контракта ручки: форма админки по ней
    // предупреждает о занятом адресе. Без неё зелёным остаётся и переименованный
    // ключ ответа, и подстановка не того поля.
    it('сообщает, что занятый слаг занят, и называет автора', async () => {
      const slug = `taken-author-slug-${Date.now()}`;
      const created = await request(http())
        .post('/admin/authors')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          translations: [{ language: 'en', name: 'Taken Slug Author', slug }],
        })
        .expect(201);
      const authorId = (created.body as { id: string }).id;

      try {
        const response = await request(http())
          .get('/admin/authors/check-slug')
          .query({ slug })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(response.body).toEqual({
          exists: true,
          existingAuthor: { id: authorId, slug },
        });

        // Тот же слаг у того же автора при редактировании занятым не считается.
        const excluded = await request(http())
          .get('/admin/authors/check-slug')
          .query({ slug, excludeId: authorId })
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(excluded.body).toEqual({ exists: false });
      } finally {
        await request(http())
          .delete(`/admin/authors/${authorId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(204);
      }
    });

    it('без токена отвечает 401 от гварда, а не 404 от чужого маршрута', async () => {
      await request(http())
        .get('/admin/authors/check-slug')
        .query({ slug: 'anything' })
        .expect(401);
    });

    it('аутентифицированному без роли отвечает 403', async () => {
      await request(http())
        .get('/admin/authors/check-slug')
        .query({ slug: 'anything' })
        .set('Authorization', `Bearer ${readerToken}`)
        .expect(403);
    });
  });

  // Положительный контроль: перестановка модулей чинит админскую сторону, но
  // не имеет права задеть публичную — её обработчики объявлены в том же
  // `PublicModule`, который переехал.
  describe('публичная сторона осталась на месте', () => {
    it('GET /en/authors отвечает 200 без токена', async () => {
      const response = await request(http()).get('/en/authors').expect(200);

      const body = response.body as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('GET /admin/authors без токена не уезжает в языковой маршрут', async () => {
      // Тот же запрос, что и выше, но со стороны публичного контроллера: если
      // бы `:lang` снова выиграл, `LangParamPipe` ответил бы 404 с текстом
      // `Route not found`, а не 401.
      const response = await request(http()).get('/admin/authors');

      expect(response.status).toBe(401);
      expect(JSON.stringify(response.body)).not.toContain('Route not found');
    });
  });
});
