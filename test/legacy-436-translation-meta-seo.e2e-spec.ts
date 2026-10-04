import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

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
    const auth =
      reg.status === 201
        ? reg
        : await request(httpServerOf(app))
            .post('/auth/login')
            .send({ email: adminEmail, password: adminPassword })
            .expect(200);
    adminToken = (auth.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { key: { startsWith: prefix } } });
    await prisma.tag.deleteMany({ where: { key: { startsWith: prefix } } });
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

    it('отвязка через seo из одних null плоским полем не перебивается', async () => {
      await send('patch', `/tags/${tagId}/translations/en`, {
        seo: { metaTitle: null, metaDescription: null },
        ogTitle: 'Flat after detach',
      }).expect(200);
      const tr = await prisma.tagTranslation.findFirstOrThrow({ where: { slug: tagSlug } });
      expect(tr).toMatchObject({ seoId: null, ogTitle: 'Flat after detach' });
    });

    it('категория: отвязка через seo из одних null плоским полем не перебивается, конфликт — за seo', async () => {
      await send('patch', `/categories/${categoryId}/translations/en`, {
        metaTitle: 'Cat flat loses',
        seo: { metaTitle: 'Cat seo wins' },
      }).expect(200);
      expect((await resolve('category', categorySlug)).meta?.title).toBe('Cat seo wins');

      await send('patch', `/categories/${categoryId}/translations/en`, {
        seo: { metaTitle: null, robots: null, canonicalUrl: null },
        ogTitle: 'Cat flat after detach',
      }).expect(200);
      const tr = await prisma.categoryTranslation.findFirstOrThrow({
        where: { slug: categorySlug },
      });
      expect(tr).toMatchObject({ seoId: null, ogTitle: 'Cat flat after detach' });
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
});
