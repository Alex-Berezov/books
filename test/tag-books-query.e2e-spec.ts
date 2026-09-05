import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookType, Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

/**
 * `LEGACY-199`. `GET /:lang/tags/:slug/books` принимал `page` и `limit` голым
 * `@Query('page') page?: number` и отдавал их сервису сырыми. Глобальный
 * `ValidationPipe` приводит примитив через `+value`, поэтому `?page=abc` давал
 * `NaN`, а `?page=` — `0`; оба уезжали в `skip`, Prisma бросала исключение,
 * и публичный маршрут отвечал **500** (проверено на проде 14.08.2026).
 *
 * 🔴 Почему e2e, а не юнит. Дефект жил ровно в связке «глобальный пайп +
 * сигнатура обработчика»: сам сервис на тех же значениях ведёт себя как
 * описано, а контроллер, вызванный из юнита напрямую, никакого приведения
 * не видит. Проверять надо ответ настоящего HTTP-запроса.
 */
describe('Tag books query validation (LEGACY-199) e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const marker = `tagq${Date.now()}`;
  const slug = `${marker}-tag`;
  let bookId = '';
  let tagId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const tag = await prisma.tag.create({
      data: { name: marker, slug, key: `${marker}-key`, isVisible: true },
    });
    tagId = tag.id;
    await prisma.tagTranslation.create({
      data: { tagId, language: Language.en, name: marker, slug },
    });

    const book = await createBookFixture(prisma, `${marker}-book`);
    bookId = book.id;
    const version = await prisma.bookVersion.create({
      data: {
        bookId,
        language: Language.en,
        title: `${marker} title`,
        author: `${marker} author`,
        description: 'e2e',
        coverImageUrl: 'https://example.invalid/cover.png',
        type: BookType.text,
        isFree: true,
        status: 'published',
        publishedAt: new Date('2026-01-01T00:00:00Z'),
        slug: `${marker}-book`,
      },
    });
    await prisma.bookTag.create({ data: { bookVersionId: version.id, tagId } });
  });

  afterAll(async () => {
    await prisma.bookTag.deleteMany({ where: { tagId } });
    await prisma.bookVersion.deleteMany({ where: { bookId } });
    await prisma.book.deleteMany({ where: { id: bookId } });
    await prisma.tagTranslation.deleteMany({ where: { tagId } });
    await prisma.tag.deleteMany({ where: { id: tagId } });
    await app.close();
  });

  const get = (query: string) => request(http()).get(`/en/tags/${slug}/books${query}`);

  it('без параметров отдаёт список книг тега', async () => {
    const res = await get('').expect(200);
    const body = res.body as { data: unknown[]; meta: { page: number; limit: number } };

    expect(body.data).toHaveLength(1);
    expect(body.meta.page).toBe(1);
    expect(body.meta.limit).toBe(20);
  });

  it('корректные page и limit доезжают до ответа', async () => {
    const res = await get('?page=1&limit=5').expect(200);
    const body = res.body as { meta: { page: number; limit: number; total: number } };

    expect(body.meta).toEqual(expect.objectContaining({ page: 1, limit: 5, total: 1 }));
  });

  /**
   * Каждое из четырёх значений отвечало 500 до правки. Проверяются все четыре,
   * а не одно: `NaN` и `0` приходят разными путями — первое из непарсимой строки,
   * второе из пустого значения, — и починка одного не чинит другое.
   */
  it.each(['?page=abc', '?page=', '?page=0', '?page=-1'])(
    'мусор в page отбивается кодом 400, а не роняет маршрут: %s',
    async (query) => {
      await get(query).expect(400);
    },
  );

  it.each(['?limit=abc', '?limit=', '?limit=0'])(
    'мусор в limit отбивается кодом 400: %s',
    async (query) => {
      await get(query).expect(400);
    },
  );

  it('limit выше потолка отбивается, а не тянет всю выдачу тега', async () => {
    await get('?limit=49').expect(400);
    await get('?limit=48').expect(200);
  });

  it('неизвестный параметр не принимается молча', async () => {
    await get('?perPage=10').expect(400);
  });
});
