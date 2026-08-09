import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

/**
 * `LEGACY-068`. `Category.key` и `Tag.key` — единственные неизменяемые
 * идентификаторы термина: по ним связывает JSON-импорт
 * (`findUnique({ where: { key } })`). Уехавший ключ там даёт не ошибку, а
 * **дубликат** — импорт не находит термин, заводит новый, прежний остаётся жить
 * со своими переводами и связями, а отчёт показывает `imported`.
 *
 * 🔴 Менять ключ можно было двумя путями: напрямую полем формы и косвенно —
 * ветка `dto.key ?? dto.slug` делала слаг ключом при PATCH без `key`, то есть
 * переименование ради URL уводило за собой опорный ключ.
 */
describe('Taxonomy key immutability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const stamp = Date.now();
  const prefix = `key-immutable-${stamp}`;
  let categoryId = '';
  let tagId = '';

  beforeAll(async () => {
    const adminEmail = 'admin-key-immutable@test.com';
    const adminPassword = 'password123';
    process.env.ADMIN_EMAILS = adminEmail;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    await app.init();

    const reg = await request(httpServerOf(app))
      .post('/auth/register')
      .send({ email: adminEmail, password: adminPassword });
    if (reg.status === 201) {
      adminToken = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(httpServerOf(app))
        .post('/auth/login')
        .send({ email: adminEmail, password: adminPassword });
      adminToken = (login.body as { accessToken: string }).accessToken;
    }

    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `Cat ${stamp}`,
        slug: `${prefix}-cat`,
        key: `${prefix}-cat-key`,
      },
    });
    categoryId = category.id;

    const tag = await prisma.tag.create({
      data: { name: `Tag ${stamp}`, slug: `${prefix}-tag`, key: `${prefix}-tag-key` },
    });
    tagId = tag.id;
  });

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { key: { startsWith: prefix } } });
    await prisma.tag.deleteMany({ where: { key: { startsWith: prefix } } });
    await app.close();
  });

  const patchCategory = (body: Record<string, unknown>) =>
    request(httpServerOf(app))
      .patch(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  // 🔴 Прямой путь.
  it('refuses to change a category key', async () => {
    const res = await patchCategory({ key: `${prefix}-hijacked` });

    expect(res.status).toBe(400);
    const after = await prisma.category.findUnique({ where: { id: categoryId } });
    expect(after?.key).toBe(`${prefix}-cat-key`);
  });

  /**
   * 🔴 Косвенный путь — тот, что срабатывал молча: PATCH со слагом и без `key`
   * перезаписывал ключ слагом. Именно он делал безобидное переименование URL
   * заменой опорного идентификатора.
   */
  it('does not turn a new slug into the key', async () => {
    const res = await patchCategory({ slug: `${prefix}-cat-renamed` });

    expect(res.status).toBe(200);
    const after = await prisma.category.findUnique({ where: { id: categoryId } });
    expect(after?.slug).toBe(`${prefix}-cat-renamed`);
    expect(after?.key).toBe(`${prefix}-cat-key`);
  });

  /**
   * ⚠️ Совпадающий ключ обязан проходить: админка отправляет `key` в каждом
   * PATCH, и 400 на неизменённое значение сломал бы редактирование целиком,
   * ничего не защитив.
   */
  it('accepts an unchanged key alongside other edits', async () => {
    const res = await patchCategory({ key: `${prefix}-cat-key`, name: `Renamed ${stamp}` });

    expect(res.status).toBe(200);
    const after = await prisma.category.findUnique({ where: { id: categoryId } });
    expect(after?.name).toBe(`Renamed ${stamp}`);
    expect(after?.key).toBe(`${prefix}-cat-key`);
  });

  // Теги — тот же класс и тот же потребитель ключа.
  it('refuses to change a tag key', async () => {
    const res = await request(httpServerOf(app))
      .patch(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key: `${prefix}-tag-hijacked` });

    expect(res.status).toBe(400);
    const after = await prisma.tag.findUnique({ where: { id: tagId } });
    expect(after?.key).toBe(`${prefix}-tag-key`);
  });

  it('does not turn a new tag slug into the key', async () => {
    const res = await request(httpServerOf(app))
      .patch(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: `${prefix}-tag-renamed` });

    expect(res.status).toBe(200);
    const after = await prisma.tag.findUnique({ where: { id: tagId } });
    expect(after?.key).toBe(`${prefix}-tag-key`);
  });
});
