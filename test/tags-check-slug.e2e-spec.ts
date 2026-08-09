/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * LEGACY-061. Своей проверки слага у тегов не было вовсе, и форма в админке
 * проверяла слаг тега **по книгам** (`entityType="book" // Fallback`): отвечала на
 * другой вопрос и молчала о совпадениях с другими тегами.
 */
describe('Tags: Check Slug (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const stamp = Date.now();
  const takenSlug = `tag-slug-${stamp}`;

  beforeAll(async () => {
    const adminEmail = 'admin-tag-slug@test.com';
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

    const regRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: adminEmail, password: adminPassword });

    if (regRes.status === 201) {
      adminToken = regRes.body.accessToken;
    } else if (regRes.status === 409) {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: adminEmail, password: adminPassword });
      adminToken = loginRes.body.accessToken;
    } else {
      throw new Error(`Unexpected admin register status: ${regRes.status}`);
    }

    await prisma.tag.create({
      data: { name: `Taken ${stamp}`, slug: takenSlug, key: takenSlug },
    });
  });

  afterAll(async () => {
    await prisma.tag.deleteMany({ where: { slug: { startsWith: `tag-slug-${stamp}` } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: `cat-slug-${stamp}` } } });
    await app.close();
  });

  it('reports a free slug as available', async () => {
    const res = await request(app.getHttpServer())
      .get('/tags/check-slug')
      .query({ slug: `tag-slug-${stamp}-free` })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toEqual({ exists: false });
  });

  it('reports a taken slug and suggests an alternative', async () => {
    const res = await request(app.getHttpServer())
      .get('/tags/check-slug')
      .query({ slug: takenSlug })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.exists).toBe(true);
    expect(res.body.suggestedSlug).toBe(`${takenSlug}-2`);
    expect(res.body.existingTag.slug).toBe(takenSlug);
  });

  // 🔴 Смысл LEGACY-061: без исключения самой записи форма сообщает «занят» на
  // собственном слаге редактируемого тега.
  it('returns exists: false when the record excludes itself', async () => {
    const tag = await prisma.tag.findFirst({ where: { slug: takenSlug } });

    const res = await request(app.getHttpServer())
      .get('/tags/check-slug')
      .query({ slug: takenSlug, excludeId: tag?.id })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toEqual({ exists: false });
  });

  // 🔴 Тег и категория — разные пространства слагов. Общая проверка запрещала бы
  // допустимое: одноимённые тег и категория законны.
  it('does not collide with a category that has the same slug', async () => {
    const sharedSlug = `cat-slug-${stamp}-shared`;
    await prisma.category.create({
      data: { type: 'genre', name: `Shared ${stamp}`, slug: sharedSlug, key: sharedSlug },
    });

    const res = await request(app.getHttpServer())
      .get('/tags/check-slug')
      .query({ slug: sharedSlug })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toEqual({ exists: false });
  });

  it('rejects a malformed slug', async () => {
    await request(app.getHttpServer())
      .get('/tags/check-slug')
      .query({ slug: 'Invalid Slug!' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get('/tags/check-slug')
      .query({ slug: 'anything' })
      .expect(401);
  });
});
