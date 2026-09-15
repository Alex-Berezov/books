import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { BookService } from '../src/modules/book/book.service';

/**
 * Тело ответа 500 на публичных маршрутах книг (`LEGACY-114`).
 *
 * Юнит-спека `src/modules/book/book.controller.errors.spec.ts` читает
 * `HttpException.getResponse()`, то есть объект **до** сериализации. Здесь
 * проверяется то, что реально уходит анониму по проводу: маршруты
 * `GET /books/:slug/overview` и `GET /books/slug/:slug` открыты без токена, и
 * именно из-за них запись заведена.
 *
 * ⚠️ Граница проверки: `SentryExceptionFilter` и `RedirectExceptionFilter`
 * регистрируются в `src/main.ts`, а тестовое приложение поднимается через
 * `Test.createTestingModule` и их не подключает. Здесь доказано, что тело не
 * содержит текста драйвера **до** этих фильтров; сами они тело ответа не
 * меняют — `SentryExceptionFilter` всегда завершает `super.catch()`.
 *
 * 13.09.2026 (`LEGACY-179`, решение владельца) контроллер перестал ловить
 * исключения: тело неожиданного отказа формирует стандартный фильтр Nest.
 * Было `{message: 'Failed to get book overview'}`, стало
 * `{statusCode: 500, message: 'Internal server error'}` — одна форма на все
 * контроллеры. Утечки текста драйвера не было и нет, и проверка на неё здесь
 * остаётся главной: раньше его резал `internalFailure`, теперь — фильтр Nest.
 */

const DRIVER_TEXT =
  'Invalid `prisma.bookVersion.findMany()` invocation: column "rights_holder_email" does not exist';

describe('Books (e2e) — тело ошибки 500 не несёт текст исключения', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BookService)
      .useValue({
        getOverview: jest.fn().mockRejectedValue(new Error(DRIVER_TEXT)),
        findBySlug: jest.fn().mockRejectedValue(new Error(DRIVER_TEXT)),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = (): Parameters<typeof request>[0] =>
    app.getHttpServer() as unknown as Parameters<typeof request>[0];

  it.each([
    ['GET /:lang/books/:slug/overview', '/en/books/harry-potter/overview'],
    ['GET /books/slug/:slug', '/books/slug/harry-potter'],
  ])('%s отвечает анониму 500 без текста драйвера', async (_name, path) => {
    const res = await request(server()).get(path);

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('prisma');
    expect(body).not.toContain('rights_holder_email');
    expect(body).not.toContain('bookVersion');
    // Сравнение тела целиком, а не поля: собственная форма контроллера
    // (`{message: 'Failed to ...'}`) обязана ронять эту спеку, даже если
    // текста драйвера в ней нет.
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
