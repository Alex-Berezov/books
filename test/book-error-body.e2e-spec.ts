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
    ['GET /books/:slug/overview', '/books/harry-potter/overview', 'Failed to get book overview'],
    ['GET /books/slug/:slug', '/books/slug/harry-potter', 'Failed to get book by slug'],
  ])('%s отвечает анониму 500 без текста драйвера', async (_name, path, message) => {
    const res = await request(server()).get(path);

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('prisma');
    expect(body).not.toContain('rights_holder_email');
    expect(body).not.toContain('bookVersion');
    expect((res.body as { message?: string }).message).toBe(message);
    expect((res.body as { details?: unknown }).details).toBeUndefined();
  });
});
