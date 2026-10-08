import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';
import { grantStaffRoles } from './helpers/staff-roles';

type ResolveBody = { meta?: { title?: string; description?: string } };

/**
 * 🔴 `LEGACY-436`, `T100` (решение арбитра 04.10.2026): meta/OG перевода тега и категории,
 * записанные импортом или API без вложенного `seo`, доходят до публичного `GET /:lang/seo/resolve`,
 * который читает только `Seo`. Тесты краснеют, если убрать `mirrorTranslationMetaToSeo` у писателя.
 */
describe('LEGACY-436 — плоские meta/OG перевода доходят до Seo (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const prefix = `l436-${Date.now()}`;
  /** Строки `Seo`, которые тест отвязал или собрал сам, — для уборки в `afterAll`. */
  const extraSeoIds: number[] = [];

  const send = (method: 'post' | 'patch', path: string, body: object) =>
    request(httpServerOf(app))
      [method](path)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);
  const resolve = async (type: 'tag' | 'category', slug: string): Promise<ResolveBody> => {
    const res = await request(httpServerOf(app))
      .get(`/en/seo/resolve?type=${type}&id=${slug}`)
      .expect(200);
    return res.body as ResolveBody;
  };

  beforeAll(async () => {
    const adminEmail = 'admin-legacy-436@test.com';
    const adminPassword = 'password123';

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
    const auth =
      reg.status === 201
        ? reg
        : await request(httpServerOf(app))
            .post('/auth/login')
            .send({ email: adminEmail, password: adminPassword })
            .expect(200);
    adminToken = (auth.body as { accessToken: string }).accessToken;
    await grantStaffRoles(app, adminEmail);
  });

  afterAll(async () => {
    // Строки `Seo`, заведённые писателями, переводы с собой не уносят (`Seo` — родитель связи):
    // снимаются отдельно, иначе остаются ничьими в общей базе прогона.
    const where = { slug: { startsWith: prefix } };
    const seoIds = [
      ...(await prisma.tagTranslation.findMany({ where, select: { seoId: true } })),
      ...(await prisma.categoryTranslation.findMany({ where, select: { seoId: true } })),
    ]
      .map((tr) => tr.seoId)
      .filter((id): id is number => id !== null);
    await prisma.category.deleteMany({ where: { key: { startsWith: prefix } } });
    await prisma.tag.deleteMany({ where: { key: { startsWith: prefix } } });
    await prisma.seo.deleteMany({ where: { id: { in: [...seoIds, ...extraSeoIds] } } });
    await app?.close();
  });

  describe('импорт', () => {
    it('тег: metaTitle из файла отдаёт resolve — и при заведении, и при повторном импорте', async () => {
      const slug = `${prefix}-tag-en`;
      const batch = (metaTitle: string) => [
        {
          key: `${prefix}-tag`,
          name: 'Imported',
          slug: `${prefix}-tag-base`,
          translations: { en: { name: 'Imported', slug, metaTitle, ogTitle: `${metaTitle} OG` } },
        },
      ];
      await send('post', '/import/tags', batch('Imported tag title')).expect(201);
      expect((await resolve('tag', slug)).meta?.title).toBe('Imported tag title');

      await send('post', '/import/tags', batch('Reimported tag title')).expect(201);
      expect((await resolve('tag', slug)).meta?.title).toBe('Reimported tag title');
      const tr = await prisma.tagTranslation.findFirstOrThrow({
        where: { slug },
        include: { seo: true },
      });
      expect(tr.seo?.ogTitle).toBe('Reimported tag title OG');
    });

    it('категория: metaTitle из файла отдаёт resolve — и при заведении, и при повторном импорте', async () => {
      const slug = `${prefix}-cat-en`;
      const batch = (metaTitle: string) => [
        {
          key: `${prefix}-cat`,
          type: 'category',
          translations: { en: { name: 'Imported', slug, metaTitle } },
        },
      ];
      await send('post', '/import/categories', batch('Imported category title')).expect(201);
      expect((await resolve('category', slug)).meta?.title).toBe('Imported category title');

      await send('post', '/import/categories', batch('Reimported category title')).expect(201);
      expect((await resolve('category', slug)).meta?.title).toBe('Reimported category title');
    });
  });

  describe('API без вложенного seo', () => {
    let tagId: string;
    const tagSlug = `${prefix}-api-tag-en`;
    let categoryId: string;
    const categorySlug = `${prefix}-api-cat-en`;

    beforeAll(async () => {
      const tag = await prisma.tag.create({
        data: { name: 'Api tag', slug: `${prefix}-api-tag`, key: `${prefix}-api-tag` },
      });
      tagId = tag.id;
      const category = await prisma.category.create({
        data: {
          name: 'Api cat',
          slug: `${prefix}-api-cat`,
          key: `${prefix}-api-cat`,
          type: 'category',
        },
      });
      categoryId = category.id;
    });

    it('тег: POST и PATCH плоским metaTitle доходят до resolve', async () => {
      await send('post', `/tags/${tagId}/translations`, {
        language: 'en',
        name: 'Api tag',
        slug: tagSlug,
        metaTitle: 'Flat tag title',
      }).expect(201);
      expect((await resolve('tag', tagSlug)).meta?.title).toBe('Flat tag title');

      await send('patch', `/tags/${tagId}/translations/en`, {
        metaTitle: 'Patched tag title',
      }).expect(200);
      expect((await resolve('tag', tagSlug)).meta?.title).toBe('Patched tag title');
    });

    it('категория: POST и PATCH плоским metaTitle доходят до resolve', async () => {
      await send('post', `/categories/${categoryId}/translations`, {
        language: 'en',
        name: 'Api cat',
        slug: categorySlug,
        metaTitle: 'Flat category title',
      }).expect(201);
      expect((await resolve('category', categorySlug)).meta?.title).toBe('Flat category title');

      await send('patch', `/categories/${categoryId}/translations/en`, {
        metaTitle: 'Patched category title',
      }).expect(200);
      expect((await resolve('category', categorySlug)).meta?.title).toBe('Patched category title');
    });

    it('POST с seo и другим плоским полем: в Seo доходят оба', async () => {
      const slug = `${prefix}-api-cat-ru`;
      await send('post', `/categories/${categoryId}/translations`, {
        language: 'ru',
        name: 'Кат',
        slug,
        seo: { metaTitle: 'From seo' },
        ogTitle: 'From flat',
      }).expect(201);
      const tr = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug },
        include: { seo: true },
      });
      expect(tr.seo).toMatchObject({ metaTitle: 'From seo', ogTitle: 'From flat' });
    });

    it('seo.X в том же запросе побеждает плоское X', async () => {
      await send('patch', `/tags/${tagId}/translations/en`, {
        metaTitle: 'Flat loses',
        seo: { metaTitle: 'Seo wins' },
      }).expect(200);
      expect((await resolve('tag', tagSlug)).meta?.title).toBe('Seo wins');
    });

    it('плоский null обнуляет только Seo.X, robots и canonicalUrl остаются', async () => {
      await send('patch', `/categories/${categoryId}/translations/en`, {
        seo: {
          metaTitle: 'Before null',
          robots: 'noindex',
          canonicalUrl: 'https://example.com/canon',
        },
      }).expect(200);
      await send('patch', `/categories/${categoryId}/translations/en`, {
        metaTitle: null,
      }).expect(200);
      const tr = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug: categorySlug },
        include: { seo: true },
      });
      expect(tr.seo).toMatchObject({
        metaTitle: null,
        robots: 'noindex',
        canonicalUrl: 'https://example.com/canon',
      });
    });

    // `T107` (решение арбитра 04.10.2026): отвязка плюс непустое плоское X без `seo.X` — 400, а не
    // молчаливое X в колонке, которую публика не читает. Ничего не пишется: ни отвязки, ни колонки.
    it('тег: отвязка через seo из одних null с непустым плоским полем — 400 без записи', async () => {
      const before = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      expect(before.seoId).not.toBeNull();

      const res = await send('patch', `/tags/${tagId}/translations/en`, {
        seo: { metaTitle: null, metaDescription: null },
        ogTitle: 'Flat after detach',
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain('ogTitle');

      const tr = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      expect(tr).toMatchObject({ seoId: before.seoId, ogTitle: before.ogTitle });
    });

    // Уточнение решения 1 (арбитр 04.10.2026): явный `seo.X = null` при отвязке не спасает плоское X.
    it('тег и категория: отвязка с явным seo.X = null и непустым плоским X — 400', async () => {
      await send('patch', `/tags/${tagId}/translations/en`, {
        seo: { metaTitle: null, metaDescription: null },
        metaTitle: 'Flat with explicit null',
      }).expect(400);
      await send('patch', `/categories/${categoryId}/translations/en`, {
        seo: { metaTitle: null, robots: null },
        metaTitle: 'Flat with explicit null',
      }).expect(400);
      const tag = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      expect(tag.seoId).not.toBeNull();
      expect(tag.metaTitle).not.toBe('Flat with explicit null');
    });

    it('тег: отвязка с плоским null допустима', async () => {
      const before = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      // До запроса: отвязанную строку выборка `afterAll` по слагу уже не найдёт.
      if (before.seoId !== null) extraSeoIds.push(before.seoId);
      await send('patch', `/tags/${tagId}/translations/en`, {
        seo: { metaTitle: null, metaDescription: null },
        ogTitle: null,
      }).expect(200);
      const tr = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      expect(tr).toMatchObject({ seoId: null, ogTitle: null });
    });

    it('категория: конфликт — за seo; отвязка с непустым плоским полем — 400, без него — отвязывает', async () => {
      await send('patch', `/categories/${categoryId}/translations/en`, {
        metaTitle: 'Cat flat loses',
        seo: { metaTitle: 'Cat seo wins' },
      }).expect(200);
      expect((await resolve('category', categorySlug)).meta?.title).toBe('Cat seo wins');

      const before = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug: categorySlug },
      });
      // До запросов: отвязанную строку выборка `afterAll` по слагу уже не найдёт.
      if (before.seoId !== null) extraSeoIds.push(before.seoId);
      await send('patch', `/categories/${categoryId}/translations/en`, {
        seo: { metaTitle: null, robots: null, canonicalUrl: null },
        ogTitle: 'Cat flat after detach',
      }).expect(400);
      const kept = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug: categorySlug },
      });
      expect(kept).toMatchObject({ seoId: before.seoId, ogTitle: before.ogTitle });

      await send('patch', `/categories/${categoryId}/translations/en`, {
        seo: { metaTitle: null, robots: null, canonicalUrl: null },
      }).expect(200);
      const tr = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug: categorySlug },
      });
      expect(tr.seoId).toBeNull();
    });

    it('PATCH пробелами на переводе без Seo строку Seo не создаёт', async () => {
      await send('patch', `/categories/${categoryId}/translations/en`, {
        metaTitle: '   ',
      }).expect(200);
      const tr = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug: categorySlug },
      });
      expect(tr.seoId).toBeNull();
    });

    it('плоский null без Seo строку Seo не создаёт', async () => {
      const slug = `${prefix}-api-tag-ru`;
      await send('post', `/tags/${tagId}/translations`, {
        language: 'ru',
        name: 'Тег',
        slug,
        metaTitle: null,
      }).expect(201);
      const tr = await prisma.tagTranslation.findFirstOrThrow({ where: { slug } });
      expect(tr.seoId).toBeNull();
    });
  });

  /**
   * `T107` (решение арбитра 04.10.2026): строка `Seo`, которую держит ещё одна сущность, PATCH-ем
   * перевода не правится — ни вложенным `seo`, ни плоским зеркалом: 409 и ничего не записано
   * (`LEGACY-400`). Общая строка собирается напрямую: схема запрещает её только внутри одной таблицы.
   */
  describe('общая строка Seo (T107)', () => {
    let tagId: string;
    let categoryId: string;
    let seoId: number;
    const tagSlug = `${prefix}-shared-tag-en`;
    const categorySlug = `${prefix}-shared-cat-en`;

    beforeAll(async () => {
      const seo = await prisma.seo.create({ data: { metaTitle: 'Shared' } });
      seoId = seo.id;
      extraSeoIds.push(seoId);
      const tag = await prisma.tag.create({
        data: { name: 'Shared', slug: `${prefix}-shared-tag`, key: `${prefix}-shared-tag` },
      });
      tagId = tag.id;
      await prisma.tagTranslation.create({
        data: { tagId, language: 'en', name: 'Shared', slug: tagSlug, seoId },
      });
      const category = await prisma.category.create({
        data: {
          name: 'Shared',
          slug: `${prefix}-shared-cat`,
          key: `${prefix}-shared-cat`,
          type: 'category',
        },
      });
      categoryId = category.id;
    });

    afterEach(async () => {
      await prisma.categoryTranslation.deleteMany({ where: { slug: categorySlug } });
    });

    const sharedSeo = () => prisma.seo.findUniqueOrThrow({ where: { id: seoId } });

    it('вложенный seo и плоское поле в общую строку — 409, Seo и перевод не меняются', async () => {
      await prisma.categoryTranslation.create({
        data: { categoryId, language: 'en', name: 'Shared', slug: categorySlug, seoId },
      });

      await send('patch', `/tags/${tagId}/translations/en`, {
        seo: { metaTitle: 'Leaks to category' },
      }).expect(409);
      await send('patch', `/tags/${tagId}/translations/en`, {
        metaTitle: 'Flat leaks',
      }).expect(409);
      await send('patch', `/categories/${categoryId}/translations/en`, {
        ogTitle: 'Flat leaks',
      }).expect(409);

      expect(await sharedSeo()).toMatchObject({ metaTitle: 'Shared', ogTitle: null });
      const tr = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      expect(tr.metaTitle).toBeNull();

      // Правка без meta/OG строку `Seo` не трогает и проходит.
      await send('patch', `/tags/${tagId}/translations/en`, { name: 'Renamed' }).expect(200);
    });

    // Решение арбитра 2 `T107`: импорт общую строку пропускает, а не отвечает 409 на всю пачку.
    it('импорт поверх общей строки Seo: пачка проходит, Seo не меняется', async () => {
      await prisma.categoryTranslation.create({
        data: { categoryId, language: 'en', name: 'Shared', slug: categorySlug, seoId },
      });

      const res = await send('post', '/import/tags', [
        {
          key: `${prefix}-shared-tag`,
          name: 'Shared',
          slug: `${prefix}-shared-tag`,
          translations: {
            en: { name: 'Shared', slug: tagSlug, metaTitle: 'Imported over shared' },
          },
        },
      ]).expect(201);

      expect((res.body as { errors: unknown[] }).errors).toEqual([]);
      expect(await sharedSeo()).toMatchObject({ metaTitle: 'Shared' });

      const catRes = await send('post', '/import/categories', [
        {
          key: `${prefix}-shared-cat`,
          type: 'category',
          translations: {
            en: { name: 'Shared', slug: categorySlug, ogTitle: 'Imported over shared' },
          },
        },
      ]).expect(201);

      expect((catRes.body as { errors: unknown[] }).errors).toEqual([]);
      expect(await sharedSeo()).toMatchObject({ metaTitle: 'Shared', ogTitle: null });
    });

    // Замок до счёта на живой базе: встречная транзакция запирает строку `Seo` и под замком привязывает
    // её ко второму владельцу. PATCH обязан встать в очередь на замке и после коммита увидеть двоих —
    // 409. Без замка он посчитал бы одного владельца до коммита и записал бы `Seo` чужой категории.
    it('PATCH ждёт замок строки Seo и после встречной привязки отвечает 409', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: (pid: number) => void = () => undefined;
      const inside = new Promise<number>((resolve) => {
        entered = resolve;
      });
      const binder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Seo" WHERE id = ${seoId} FOR UPDATE`;
          await tx.categoryTranslation.create({
            data: { categoryId, language: 'en', name: 'Shared', slug: categorySlug, seoId },
          });
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          entered(row.pid);
          await held;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      let patch: Promise<request.Response> | undefined;
      let blocked = false;
      try {
        // Упади встречная транзакция до замка — тест падает её ошибкой, а не висит на `inside`.
        const holderPid = await Promise.race([
          inside,
          binder.then(() => {
            throw new Error('binder committed without signalling the lock');
          }),
        ]);
        // `then` запускает запрос сразу: supertest без него ленив.
        patch = send('patch', `/tags/${tagId}/translations/en`, { metaTitle: 'Raced' }).then(
          (res) => res,
        );
        const until = Date.now() + 10_000;
        while (!blocked && Date.now() < until) {
          const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
          blocked = row.n > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        release();
      }
      await binder;
      const res = await patch;

      expect(blocked).toBe(true);
      expect(res?.status).toBe(409);
      expect(await sharedSeo()).toMatchObject({ metaTitle: 'Shared' });
    }, 60_000);
  });
});
