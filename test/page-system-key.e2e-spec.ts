/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * A2, `tasks/system-pages-slug/TASK.md`. Пять страниц сайт ищет сам, и адресом
 * служил слаг — поле, которое админка генерирует из заголовка. Переименование
 * заголовка рвало связь беззвучно: страница отвечала 200, но уже без своих
 * metaTitle, metaDescription, h1, SEO-текста и FAQ. На проде это случилось —
 * `homepage-index` стал `homepage` на обычном сохранении.
 */
describe('Pages: system key (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const stamp = Date.now();
  const slugPrefix = `sys-page-${stamp}`;

  /** Ключ, который тест одалживает. Настоящий владелец получает его назад в afterAll. */
  const BORROWED_KEY = 'taxonomy-tags';
  const BORROWED_LANG = Language.ru;
  let originalHolderId: string | null = null;

  beforeAll(async () => {
    const adminEmail = 'admin-system-key@test.com';
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

    // Своей системной страницы в тестовой базе может и не быть, а ключи —
    // закрытый список, выдумать шестой нельзя. Поэтому один одалживаем.
    const holder = await prisma.page.findFirst({
      where: { systemKey: BORROWED_KEY, language: BORROWED_LANG },
      select: { id: true },
    });
    originalHolderId = holder?.id ?? null;
  });

  afterAll(async () => {
    await prisma.page.deleteMany({ where: { slug: { startsWith: slugPrefix } } });
    if (originalHolderId) {
      await prisma.page.update({
        where: { id: originalHolderId },
        data: { systemKey: BORROWED_KEY },
      });
    }
    await app.close();
  });

  /**
   * Отдаёт ключ новой странице. Уникальность составная — (язык, ключ) — поэтому
   * прежний держатель обязан сначала его отпустить, иначе вставка упадёт.
   */
  const givePageTheKey = async (slug: string) => {
    await prisma.page.updateMany({
      where: { systemKey: BORROWED_KEY, language: BORROWED_LANG },
      data: { systemKey: null },
    });

    return prisma.page.create({
      data: {
        slug,
        title: `System page ${stamp}`,
        type: 'generic',
        content: 'body',
        status: 'published',
        language: BORROWED_LANG,
        systemKey: BORROWED_KEY,
        h1: `H1 ${stamp}`,
      },
    });
  };

  it('resolves a system page by its key', async () => {
    const page = await givePageTheKey(`${slugPrefix}-plain`);

    const res = await request(app.getHttpServer())
      .get('/ru/pages/by-key/taxonomy-tags')
      .expect(200);

    expect(res.body.id).toBe(page.id);
    expect(res.body.h1).toBe(`H1 ${stamp}`);
  });

  // 🔴 Ровно тот инцидент: заголовок переименовали, слаг перегенерировался.
  // Раньше это стоило странице всего её SEO-контента. Теперь — ничего.
  it('keeps resolving after the slug is renamed out from under it', async () => {
    const page = await givePageTheKey(`${slugPrefix}-before-rename`);

    await prisma.page.update({
      where: { id: page.id },
      data: { slug: `${slugPrefix}-after-rename` },
    });

    const res = await request(app.getHttpServer())
      .get('/ru/pages/by-key/taxonomy-tags')
      .expect(200);

    expect(res.body.id).toBe(page.id);
    expect(res.body.h1).toBe(`H1 ${stamp}`);

    // Старый адрес по слагу при этом отвечать перестал — именно это и делало
    // поломку невидимой, пока сайт ходил по слагу.
    await request(app.getHttpServer()).get(`/ru/pages/${slugPrefix}-before-rename`).expect(404);
  });

  // 🔴 Хаб, отвечающий на чужом языке, хуже хаба на словарных строках: он
  // индексируется. Фолбэка на другой язык здесь нет намеренно.
  it('does not fall back to another language', async () => {
    await givePageTheKey(`${slugPrefix}-ru-only`);

    await request(app.getHttpServer()).get('/fr/pages/by-key/taxonomy-tags').expect(404);
  });

  it('does not serve a draft system page', async () => {
    const page = await givePageTheKey(`${slugPrefix}-draft`);
    await prisma.page.update({ where: { id: page.id }, data: { status: 'draft' } });

    await request(app.getHttpServer()).get('/ru/pages/by-key/taxonomy-tags').expect(404);
  });

  /**
   * 🔴 Список ключей закрыт: иначе маршрут превращается в способ перебирать
   * страницы по колонке, которой нет ни в одном DTO.
   *
   * Страница с посторонним ключом заводится здесь **намеренно**: без неё тест
   * получал бы 404 просто потому, что такой строки нет, и проверял бы состояние
   * базы, а не наличие проверки. С ней снятие `isSystemPageKey` немедленно
   * отдаёт страницу наружу.
   */
  it('rejects a key outside the closed list', async () => {
    const page = await prisma.page.create({
      data: {
        slug: `${slugPrefix}-not-a-system-page`,
        title: 'Not a system page',
        type: 'generic',
        content: 'body',
        status: 'published',
        language: BORROWED_LANG,
        systemKey: 'internal-something',
      },
    });

    await request(app.getHttpServer()).get('/ru/pages/by-key/internal-something').expect(404);

    // Страница существует и опубликована — 404 выше пришёл от проверки ключа,
    // а не от того, что искать было нечего.
    const stillThere = await prisma.page.findUnique({ where: { id: page.id } });
    expect(stillThere?.status).toBe('published');
  });

  // 🔴 `systemKey` — не редактируемое поле. Просочись оно в DTO страницы,
  // редактор увёл бы хаб на чужую страницу, и весь смысл A2 пропал бы.
  it('refuses to accept systemKey from an editor', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/ru/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        slug: `${slugPrefix}-hijack`,
        title: 'Hijack attempt',
        type: 'generic',
        content: 'body',
        systemKey: 'homepage',
      });

    expect(res.status).toBe(400);
  });
});
