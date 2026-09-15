import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

/**
 * `LEGACY-010`. Замена удалённому `language-policy-categories-tags.e2e-spec.ts`.
 *
 * Тот набор проверял выбор языка на безъязыких `GET /categories/:slug/books`
 * и `GET /tags/:slug/books` — по `?lang` и `Accept-Language`. Маршруты сняты
 * 14.09.2026 решением владельца, и вместе с ними ушёл бы **весь** сторож
 * языковой фильтрации таксономических списков: у выживших `/:lang/...` версий
 * её не утверждает ни один тест (проверено grep'ом по `test/**`).
 *
 * Здесь та же предметная проверка, но язык задаётся путём, а не заголовком:
 * `/:lang/categories/:slug/books` и `/:lang/tags/:slug/books` обязаны отдавать
 * только версии своего языка и перечислять все доступные в `availableLanguages`.
 *
 * 🔴 Краснеет от снятия `language: pathLang` в `CategoryService.getByLangSlugWithBooks`
 * или `TagsService.versionsByTagLangSlug` — то есть ровно от того, что прежний
 * набор ловил на своей половине.
 */

/** Карточка книги в `GET /:lang/categories/:slug/books` — только то, на чём стоят утверждения. */
type CategoryBookCard = { versions: Array<{ language: string }> };

/** Версия в `GET /:lang/tags/:slug/books` — только то, на чём стоят утверждения. */
type TaggedVersion = { language: string };

/**
 * Формы ответов выписаны поимённо, а не заглушены правилом линтера. `supertest` типизирует
 * `body` как `any`, и прежний набор снимал проверку строкой в шапке файла — то есть глушил
 * её и на всех остальных обращениях заодно, а не только там, где иначе было нельзя.
 */
type CategoryListingBody = { data: CategoryBookCard[]; availableLanguages: string[] };
type TagListingBody = { data: TaggedVersion[] };
type TokenBody = { accessToken: string };
type IdBody = { id: string };

describe('Языковая политика списков категорий и тегов (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let bookSlug: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      admin = (reg.body as TokenBody).accessToken;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      admin = (login.body as TokenBody).accessToken;
    } else {
      throw new Error('Admin auth failed');
    }
  });

  afterAll(async () => {
    if (bookSlug) {
      await cleanupBookWithRights(prisma, bookSlug);
    }
    await app.close();
  });

  it('язык пути отбирает версии и не сужает availableLanguages', async () => {
    bookSlug = `lang-taxonomy-${Date.now()}`;
    const bookWithRights = await createBookWithRights(prisma, bookSlug);

    const vEN = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        language: Language.en,
        title: 'EN Text',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/en.jpg',
        type: BookType.text,
        isFree: true,
        seoMetaTitle: 'SEO EN',
      })
      .expect(201);
    const vENid = (vEN.body as IdBody).id;

    const vES = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        language: Language.es,
        title: 'ES Audio',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/es.jpg',
        type: BookType.audio,
        isFree: false,
        seoMetaTitle: 'SEO ES',
      })
      .expect(201);
    const vESid = (vES.body as IdBody).id;

    await request(http())
      .patch(`/versions/${vENid}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    await request(http())
      .patch(`/versions/${vESid}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    const catSlug = `lang-cat-${Date.now()}`;
    const category = await prisma.category.create({
      data: { type: 'genre', name: `LangCat ${Date.now()}`, slug: catSlug, key: catSlug },
    });
    await prisma.bookCategory.create({ data: { bookVersionId: vENid, categoryId: category.id } });
    await prisma.bookCategory.create({ data: { bookVersionId: vESid, categoryId: category.id } });

    const tagSlug = `lang-tag-${Date.now()}`;
    const tag = await prisma.tag.create({
      data: { name: `LangTag ${Date.now()}`, slug: tagSlug, key: tagSlug },
    });
    await prisma.bookTag.create({ data: { bookVersionId: vENid, tagId: tag.id } });
    await prisma.bookTag.create({ data: { bookVersionId: vESid, tagId: tag.id } });

    // Категория под `en`: в выдаче только книги, у которых есть английская версия.
    const catEN = await request(http()).get(`/en/categories/${category.slug}/books`).expect(200);
    const catENbody = catEN.body as CategoryListingBody;
    const catENbooks = catENbody.data;
    expect(catENbooks.length).toBeGreaterThan(0);
    expect(catENbooks.every((b) => b.versions.some((v) => v.language === 'en'))).toBe(true);

    // `availableLanguages` перечисляет ВСЕ языки термина, а не только текущий:
    // на нём держится переключатель языка на странице.
    expect(catENbody.availableLanguages).toEqual(expect.arrayContaining(['en', 'es']));

    // `LEGACY-389`, утверждающая половина. Раньше здесь стояло характеризующее
    // ожидание «чужие языки приезжают»: отбор по языку пути стоял только на уровне
    // книги (`where.versions.some.language`), а вложенная выборка версий фильтровала
    // один `status`. Теперь фильтр стоит на обоих уровнях, и внутри книги нет ничего,
    // кроме языка пути, — ровно как у соседнего маршрута тега ниже.
    const catENversions = catENbooks.flatMap((b) => b.versions);
    expect(catENversions.length).toBeGreaterThan(0);
    expect(catENversions.every((v) => v.language === 'en')).toBe(true);

    // Та же категория под `es` — отбор идёт по языку пути, а не по порядку строк в базе.
    const catES = await request(http()).get(`/es/categories/${category.slug}/books`).expect(200);
    const catESbooks = (catES.body as CategoryListingBody).data;
    expect(catESbooks.length).toBeGreaterThan(0);
    expect(catESbooks.every((b) => b.versions.some((v) => v.language === 'es'))).toBe(true);

    // Тег под `es`.
    const tagES = await request(http()).get(`/es/tags/${tag.slug}/books`).expect(200);
    const tagESversions = (tagES.body as TagListingBody).data;
    expect(tagESversions.length).toBeGreaterThan(0);
    expect(tagESversions.every((v) => v.language === 'es')).toBe(true);

    // Тот же тег под `en` — другой набор.
    const tagEN = await request(http()).get(`/en/tags/${tag.slug}/books`).expect(200);
    const tagENversions = (tagEN.body as TagListingBody).data;
    expect(tagENversions.length).toBeGreaterThan(0);
    expect(tagENversions.every((v) => v.language === 'en')).toBe(true);
  });
});
