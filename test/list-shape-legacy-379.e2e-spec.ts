import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { httpServerOf } from './http-server';

/**
 * `LEGACY-379`: списочные маршруты отдают `{items, pagination}`, а не голый массив.
 *
 * Здесь — три маршрута, которым не нужна фикстура: остальные одиннадцать проверяются
 * в спеках своих модулей (`categories`, `category-translation-seo`, `tag-translation-seo`,
 * `book-version`, `pages`, `user-roles`, `rights-lawyer-workflow`).
 */
describe('List shape e2e (LEGACY-379)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.RATE_LIMIT_AUTH_ENABLED = '0';
    process.env.RATE_LIMIT_GLOBAL_ENABLED = '0';
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(httpServerOf(app)).post('/auth/register').send({ email, password });
    if (![201, 409].includes(reg.status)) {
      throw new Error(`Unexpected admin register status: ${reg.status}`);
    }
    const login = await request(httpServerOf(app))
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    adminToken = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const expectListShape = (body: unknown): void => {
    expect(Array.isArray(body)).toBe(false);
    const { items, pagination } = body as { items: unknown; pagination: unknown };
    expect(Array.isArray(items)).toBe(true);
    const length = (items as unknown[]).length;
    expect(pagination).toEqual({
      page: 1,
      limit: length,
      total: length,
      totalPages: length > 0 ? 1 : 0,
    });
  };

  it('GET /books/themes', async () => {
    const res = await request(httpServerOf(app))
      .get('/books/themes')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expectListShape(res.body);
  });

  it('GET /:lang/authors/letters', async () => {
    const res = await request(httpServerOf(app)).get('/en/authors/letters').expect(200);
    expectListShape(res.body);
  });

  it('GET /admin/rights/intakes/:intakeId/approvals', async () => {
    const res = await request(httpServerOf(app))
      .get(`/admin/rights/intakes/${randomUUID()}/approvals`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expectListShape(res.body);
  });
});
