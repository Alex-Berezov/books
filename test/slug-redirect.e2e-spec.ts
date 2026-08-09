import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SlugRedirectService } from '../src/modules/slug-redirect/slug-redirect.service';

/**
 * LEGACY-062. Слаг таксономии — индексируемый публичный URL, и до этой правки
 * `update()` перезаписывал его на месте: прошлое значение исчезало без следа, старый
 * адрес немедленно начинал отдавать 404, накопленные поисковые сигналы не переносились.
 *
 * Проверки идут на настоящей базе: дефекты этого класса живут в форме запроса и в
 * порядке шагов внутри транзакции, а не в логике вокруг них.
 */
describe('Slug redirects (LEGACY-062) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redirects: SlugRedirectService;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const stamp = Date.now();

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    redirects = moduleRef.get(SlugRedirectService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const password = 'password123';
    const reg = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (reg.status === 201) {
      adminAccess = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = (login.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    await prisma.slugRedirect.deleteMany({ where: { oldSlug: { contains: `sr-${stamp}` } } });
    await app.close();
  });

  it('records a redirect when a category translation slug changes', async () => {
    const created = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ type: 'genre', name: `SR ${stamp}`, slug: `sr-${stamp}-base`, key: `sr-${stamp}` })
      .expect(201);
    const categoryId = (created.body as { id: string }).id;

    await request(http())
      .post(`/categories/${categoryId}/translations`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ language: 'en', name: 'Old name', slug: `sr-${stamp}-old` })
      .expect(201);

    await request(http())
      .patch(`/categories/${categoryId}/translations/en`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: `sr-${stamp}-new` })
      .expect(200);

    const resolved = await redirects.resolve('category', 'en', `sr-${stamp}-old`);
    expect(resolved).toBe(`sr-${stamp}-new`);

    // Публичный маршрут отдаёт то же самое — им пользуется фронт при 404.
    const res = await request(http())
      .get(`/en/slug-redirect?entityType=category&slug=sr-${stamp}-old`)
      .expect(200);
    expect((res.body as { newSlug: string | null }).newSlug).toBe(`sr-${stamp}-new`);

    await prisma.categoryTranslation.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
  });

  it('answers newSlug: null for a slug nobody retired', async () => {
    // Не 404: отсутствие редиректа не должно быть неотличимо от отказа сети.
    const res = await request(http())
      .get(`/en/slug-redirect?entityType=category&slug=never-existed-${stamp}`)
      .expect(200);
    expect((res.body as { newSlug: string | null }).newSlug).toBeNull();
  });

  it('collapses a chain so an old address needs one hop, not two', async () => {
    // A→B, затем B→C. Без схлопывания браузер шёл бы A→B→C, а Google учитывает
    // ограниченное число звеньев.
    await redirects.record({
      entityType: 'tag',
      language: 'en',
      oldSlug: `sr-${stamp}-a`,
      newSlug: `sr-${stamp}-b`,
    });
    await redirects.record({
      entityType: 'tag',
      language: 'en',
      oldSlug: `sr-${stamp}-b`,
      newSlug: `sr-${stamp}-c`,
    });

    expect(await redirects.resolve('tag', 'en', `sr-${stamp}-a`)).toBe(`sr-${stamp}-c`);
    expect(await redirects.resolve('tag', 'en', `sr-${stamp}-b`)).toBe(`sr-${stamp}-c`);
  });

  it('never leaves a redirect pointing at itself when a slug is swapped back', async () => {
    // A→B, затем B→A. Наивная реализация оставила бы A→A — бесконечный переход.
    await redirects.record({
      entityType: 'tag',
      language: 'ru',
      oldSlug: `sr-${stamp}-x`,
      newSlug: `sr-${stamp}-y`,
    });
    await redirects.record({
      entityType: 'tag',
      language: 'ru',
      oldSlug: `sr-${stamp}-y`,
      newSlug: `sr-${stamp}-x`,
    });

    const selfPointing = await prisma.slugRedirect.findMany({
      where: { entityType: 'tag', language: 'ru', oldSlug: { contains: `sr-${stamp}` } },
    });
    for (const row of selfPointing) expect(row.oldSlug).not.toBe(row.newSlug);

    // Адрес, снова ставший живым, никуда не уводит.
    expect(await redirects.resolve('tag', 'ru', `sr-${stamp}-x`)).toBeNull();
  });

  /**
   * Базовый слаг — отдельный путь, и его легко было пропустить: редиректы сначала
   * писались только для переводов. Между тем именно базовый слаг правит
   * `CategoryModal`, а публичный URL резолвится по слагу перевода **с фолбэком на
   * базовый** — то есть его смена ломает адрес во всех языках сразу.
   */
  it('records a redirect for every language when the base slug changes', async () => {
    const created = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        type: 'collection',
        name: `SR base ${stamp}`,
        slug: `sr-${stamp}-base-old`,
        key: `sr-${stamp}-base`,
      })
      .expect(201);
    const categoryId = (created.body as { id: string }).id;

    await request(http())
      .patch(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      // `key` передаётся явно: без него сервис выводит его из слага (LEGACY-068).
      .send({ slug: `sr-${stamp}-base-new`, key: `sr-${stamp}-base` })
      .expect(200);

    for (const language of ['en', 'ru', 'es', 'fr', 'pt'] as const) {
      expect(await redirects.resolve('category', language, `sr-${stamp}-base-old`)).toBe(
        `sr-${stamp}-base-new`,
      );
    }

    await prisma.category.delete({ where: { id: categoryId } });
  });

  it('keeps languages apart', async () => {
    await redirects.record({
      entityType: 'tag',
      language: 'fr',
      oldSlug: `sr-${stamp}-shared`,
      newSlug: `sr-${stamp}-fr`,
    });
    expect(await redirects.resolve('tag', 'es', `sr-${stamp}-shared`)).toBeNull();
  });
});
