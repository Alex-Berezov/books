import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BookType, Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

/**
 * У каждой языковой версии свой слаг, и запись его проверяет так же, как подсказка админки
 * (`findVersionSlugConflict`): слаг, который держит `Book.slug` другой книги или версия другой
 * книги в любом языке, молча увёл бы живой адрес той книги на эту - 400. Свои слаги (`Book.slug`
 * своей книги) и прежний, уже записанный слаг сохранению не мешают.
 */
describe('BookVersion slug conflicts on write (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  const stamp = Date.now();
  const ownSlug = `vsc-own-${stamp}`;
  const otherSlug = `vsc-other-${stamp}`;
  const otherVersionSlug = `vsc-other-es-${stamp}`;
  let ownBookId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const versionBody = (language: Language, slug: string) => ({
    language,
    slug,
    title: 'Title',
    author: 'Author',
    description: 'Desc',
    coverImageUrl: 'https://example.com/cover.jpg',
    type: BookType.text,
    isFree: true,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin-vsc@example.com';
    const email = 'admin-vsc@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = (login.body as { accessToken: string }).accessToken;
    }

    ownBookId = (
      await createBookWithRights(prisma, ownSlug, { languages: [Language.en, Language.ru] })
    ).book.id;
    const other = await createBookWithRights(prisma, otherSlug, { languages: [Language.es] });
    await request(http())
      .post(`/books/${other.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(versionBody(Language.es, otherVersionSlug))
      .expect(201);
  });

  afterAll(async () => {
    await cleanupBookWithRights(prisma, ownSlug);
    await cleanupBookWithRights(prisma, otherSlug);
    await app.close();
  });

  const create = (language: Language, slug: string) =>
    request(http())
      .post(`/books/${ownBookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(versionBody(language, slug));

  it('create: Book.slug of another book is refused', async () => {
    const res = await create(Language.ru, otherSlug).expect(400);

    expect(JSON.stringify(res.body)).toContain('another book');
  });

  it('create: a version slug of another book in another language is refused', async () => {
    const res = await create(Language.ru, otherVersionSlug).expect(400);

    expect(JSON.stringify(res.body)).toContain('another book');
  });

  it('create: the own Book.slug is free; update: other books are refused, the kept slug is not', async () => {
    const created = await create(Language.en, ownSlug).expect(201);
    const versionId = (created.body as { id: string }).id;

    const patch = (slug: string) =>
      request(http())
        .patch(`/versions/${versionId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug });

    const toOtherBook = await patch(otherSlug).expect(400);
    expect(JSON.stringify(toOtherBook.body)).toContain('another book');
    await patch(otherVersionSlug).expect(400);

    // Прежний слаг не меняется - проверка не зовётся, сохранение проходит.
    await patch(ownSlug).expect(200);

    const stored = await prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { slug: true },
    });
    expect(stored?.slug).toBe(ownSlug);
  });

  it('own book in another language is free; a version of another book in the same language keeps the old text', async () => {
    const ru = await create(Language.ru, `${ownSlug}-ru`).expect(201);
    const ruId = (ru.body as { id: string }).id;
    const patchRu = (slug: string) =>
      request(http())
        .patch(`/versions/${ruId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ slug });

    // Свой слаг у русской версии не трогает ни английскую версию, ни `Book.slug` — ради этого
    // и была правка: слаг одного языка расходился на все.
    await patchRu(`${ownSlug}-ru-own`).expect(200);
    const afterOwn = await prisma.bookVersion.findMany({
      where: { bookId: ownBookId },
      select: { language: true, slug: true },
      orderBy: { language: 'asc' },
    });
    expect(afterOwn).toEqual([
      { language: Language.en, slug: ownSlug },
      { language: Language.ru, slug: `${ownSlug}-ru-own` },
    ]);
    const book = await prisma.book.findUnique({ where: { id: ownBookId }, select: { slug: true } });
    expect(book?.slug).toBe(ownSlug);

    // Слаг версии en той же книги и её `Book.slug` ведут в ту же книгу.
    await patchRu(ownSlug).expect(200);

    const otherRu = await createBookWithRights(prisma, `${otherSlug}-ru`, {
      languages: [Language.ru],
    });
    const takenInRu = await request(http())
      .post(`/books/${otherRu.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(versionBody(Language.ru, ownSlug))
      .expect(400);
    await cleanupBookWithRights(prisma, `${otherSlug}-ru`);
    expect(JSON.stringify(takenInRu.body)).toContain('another version in this language');
  });
});
